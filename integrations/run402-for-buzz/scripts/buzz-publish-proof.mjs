#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parse, evaluate } from "@humanwhocodes/momoa";

function stop(code, message, details = {}) {
  console.error(JSON.stringify({ status: "error", code, message, retryable: false, safe_to_retry: true, mutation_state: "none", details }));
  process.exit(1);
}

function flag(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) stop("BAD_USAGE", `${name} is required`);
  return process.argv[index + 1];
}

function strictJson(text, label) {
  let ast;
  try { ast = parse(text, { mode: "json", allowTrailingCommas: false }); }
  catch { stop("IDENTITY_LINK_INVALID_JSON", `${label} is not valid JSON`); }
  const walk = (node, path = "$") => {
    if (node.type === "Document") return walk(node.body, path);
    if (node.type === "Object") {
      const seen = new Set();
      for (const member of node.members) {
        const name = member.name.value ?? member.name.name;
        if (seen.has(name)) stop("IDENTITY_LINK_DUPLICATE_FIELD", `${label} contains a duplicate field`, { field: `${path}.${name}` });
        if (/(private.?key|secret|mnemonic|seed|nsec)/i.test(name)) stop("IDENTITY_LINK_SECRET_INPUT_FORBIDDEN", `${label} contains a forbidden secret-shaped field`, { field: `${path}.${name}` });
        seen.add(name);
        walk(member.value, `${path}.${name}`);
      }
    } else if (node.type === "Array") node.elements.forEach((entry, i) => walk(entry.value, `${path}[${i}]`));
  };
  walk(ast);
  return evaluate(ast);
}

function runBuzz(args) {
  const result = spawnSync("buzz", args, { encoding: "utf8", shell: false, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    stop("BUZZ_COMMAND_FAILED", "Buzz public signing command failed", { command: args.slice(0, 2).join(" "), exit_code: result.status, stderr: String(result.stderr ?? "").slice(0, 500) });
  }
  return String(result.stdout);
}

const beginPath = flag("--begin");
const eventPath = flag("--event");
const begin = strictJson(readFileSync(beginPath, "utf8"), "begin response");
if (!begin || typeof begin !== "object" || typeof begin.proof_content !== "string" || begin.visibility !== "public") {
  stop("IDENTITY_LINK_BEGIN_INVALID", "Begin response must contain public proof_content");
}
if (Object.keys(begin).some((key) => /(private.?key|secret|mnemonic|seed|nsec)/i.test(key))) {
  stop("IDENTITY_LINK_SECRET_INPUT_FORBIDDEN", "Begin response contains a forbidden secret-shaped field");
}

const published = runBuzz(["social", "publish", "--content", begin.proof_content]);
let eventId;
try {
  // Released Buzz versions may return JSON or a short prose receipt. Do not
  // route this optional parse through stop(), because the bounded event-id
  // fallback below is part of the supported released-client contract.
  const value = evaluate(parse(published, { mode: "json", allowTrailingCommas: false }));
  eventId = typeof value === "string" ? value : value?.event_id ?? value?.id;
} catch { /* the bounded regex fallback handles released prose output */ }
if (typeof eventId !== "string" || !/^[0-9a-f]{64}$/.test(eventId)) {
  eventId = published.match(/\b[0-9a-f]{64}\b/)?.[0];
}
if (!eventId) stop("BUZZ_EVENT_ID_MISSING", "Buzz publish output did not contain one event id");

const fetched = strictJson(runBuzz(["social", "event", "--event", eventId]), "Buzz event output");
const event = Array.isArray(fetched) && fetched.length === 1 ? fetched[0] : fetched;
const fields = ["content", "created_at", "id", "kind", "pubkey", "sig", "tags"];
if (!event || typeof event !== "object" || Object.keys(event).sort().join(",") !== fields.sort().join(",") || event.id !== eventId || event.kind !== 1 || event.content !== begin.proof_content) {
  stop("BUZZ_EVENT_SHAPE_MISMATCH", "Buzz did not return the exact standalone seven-field kind-1 event for proof_content");
}
writeFileSync(eventPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ event_id: event.id, event_file: eventPath, pubkey: event.pubkey, kind: event.kind, tags_count: Array.isArray(event.tags) ? event.tags.length : null }));
