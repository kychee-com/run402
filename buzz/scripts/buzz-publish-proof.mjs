#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseStrictJson } from "./strict-json.mjs";

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
  try { return parseStrictJson(text, label); }
  catch (error) { stop(error.code ?? "IDENTITY_LINK_INVALID_JSON", error.message, error.details); }
}

function rejectSecretFields(value, label, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSecretFields(entry, label, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (/(private.?key|secret|mnemonic|seed|nsec)/i.test(key)) {
      stop("IDENTITY_LINK_SECRET_INPUT_FORBIDDEN", `${label} contains a forbidden secret-shaped field`, { field: `${path}.${key}` });
    }
    rejectSecretFields(entry, label, `${path}.${key}`);
  }
}

function runBuzz(args) {
  const result = spawnSync("buzz", args, { encoding: "utf8", shell: false, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    stop("BUZZ_COMMAND_FAILED", "Buzz public signing command failed", { command: args.slice(0, 2).join(" "), exit_code: result.status });
  }
  return String(result.stdout);
}

function readBoundedPublicJson(path, label) {
  const bytes = readFileSync(path);
  if (bytes.byteLength > 32 * 1024) stop("IDENTITY_LINK_INVALID_JSON", `${label} exceeds the 32768-byte public proof limit`);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { stop("IDENTITY_LINK_INVALID_UTF8", `${label} must be valid UTF-8 JSON`); }
}

const beginPath = flag("--begin");
const eventPath = flag("--event");
const begin = strictJson(readBoundedPublicJson(beginPath, "begin response"), "begin response");
rejectSecretFields(begin, "begin response");
if (!begin || typeof begin !== "object" || typeof begin.proof_content !== "string"
  || begin.visibility !== "public" || !/^[0-9a-f]{64}$/.test(begin.nostr_pubkey)) {
  stop("IDENTITY_LINK_BEGIN_INVALID", "Begin response must contain public proof_content and a normalized Nostr pubkey");
}

const published = runBuzz(["social", "publish", "--content", begin.proof_content]);
let eventId;
try {
  // Released Buzz versions may return JSON or a short prose receipt. Do not
  // route this optional parse through stop(), because the bounded event-id
  // fallback below is part of the supported released-client contract.
  const value = parseStrictJson(published, "Buzz publish output");
  eventId = typeof value === "string" ? value : value?.event_id ?? value?.id;
} catch { /* the bounded regex fallback handles released prose output */ }
if (typeof eventId !== "string" || !/^[0-9a-f]{64}$/.test(eventId)) {
  eventId = published.match(/\b[0-9a-f]{64}\b/)?.[0];
}
if (!eventId) stop("BUZZ_EVENT_ID_MISSING", "Buzz publish output did not contain one event id");

const fetchedBytes = runBuzz(["social", "event", "--event", eventId]);
if (Buffer.byteLength(fetchedBytes, "utf8") > 32 * 1024) {
  stop("IDENTITY_LINK_INVALID_JSON", "Buzz event output exceeds the 32768-byte public proof limit");
}
const fetched = strictJson(fetchedBytes, "Buzz event output");
const event = Array.isArray(fetched) && fetched.length === 1 ? fetched[0] : fetched;
const fields = ["content", "created_at", "id", "kind", "pubkey", "sig", "tags"];
if (!event || typeof event !== "object" || Array.isArray(event)
  || Object.keys(event).sort().join(",") !== fields.sort().join(",")
  || event.id !== eventId || !/^[0-9a-f]{64}$/.test(event.id)
  || !/^[0-9a-f]{64}$/.test(event.pubkey)
  || !Number.isInteger(event.created_at) || event.kind !== 1
  || !/^[0-9a-f]{128}$/.test(event.sig)
  || event.content !== begin.proof_content || !Array.isArray(event.tags)) {
  stop("BUZZ_EVENT_SHAPE_MISMATCH", "Buzz did not return the exact standalone seven-field kind-1 event for proof_content");
}
if (event.pubkey !== begin.nostr_pubkey) {
  stop("WRONG_NOSTR_PRINCIPAL", "Buzz signed the proof as a different Nostr principal; do not use the desktop-owner callback for an agent link", {
    expected_pubkey: begin.nostr_pubkey,
    observed_pubkey: event.pubkey,
  });
}
const emptyTags = event.tags.length === 0;
const frozenOwnerTag = event.tags.length === 1
  && Array.isArray(event.tags[0])
  && event.tags[0].length === 4
  && event.tags[0][0] === "auth"
  && /^[0-9a-f]{64}$/.test(event.tags[0][1])
  && event.tags[0][1] !== event.pubkey
  && event.tags[0][2] === ""
  && /^[0-9a-f]{128}$/.test(event.tags[0][3]);
if (!emptyTags && !frozenOwnerTag) {
  stop("IDENTITY_LINK_UNSAFE_TAGS", "Buzz event tags must be empty or one empty-condition NIP-OA owner attestation");
}
writeFileSync(eventPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ event_id: event.id, event_file: eventPath, pubkey: event.pubkey, kind: event.kind, tags_count: Array.isArray(event.tags) ? event.tags.length : null }));
