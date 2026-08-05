import { readFileSync } from "node:fs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { normalizeArgv, assertKnownFlags, flagValue, requirePositionalCount, failUnknownSubcommand } from "./argparse.mjs";

const HELP = `run402 identity link — public proof-backed external identities

Usage:
  run402 identity link nostr begin --pubkey <npub|hex> --visibility public [--idempotency-key <key>]
  run402 identity link nostr complete --event-file <raw-event.json>
  run402 identity link nostr complete --event-stdin
  run402 identity link list
  run402 identity link show <identity_link_id>
  run402 identity link revoke <identity_link_id>

Security and disclosure:
  - Human linking is a browser/passkey/Buzz ceremony. Open
    https://console.run402.com/identity-links/connect; do not paste a signed
    event, passkey, session, private key, or resource id into the CLI.
  - A human identity link and an organization membership are independent:
    either can be revoked without implicitly revoking the other.
  - list uses the active CLI identity: an agent wallet when present, otherwise
    the signed-in human control-plane session.
  - begin publishes a standalone public kind-1 Nostr event and creates a durable
    public run402 proof for the agent. Revocation does not erase either historical proof.
  - the Nostr key and run402 wallet stay separate. This command never accepts,
    derives, reads, or prints an nsec, Nostr private key, mnemonic, or seed.
  - the wallet, agent pubkey, and optional Buzz NIP-OA owner attestation become
    public. Never put private workspace or channel content in the proof.
  - complete accepts only the exact raw seven-field event envelope from a file
    or stdin. Progress/errors go to stderr; stdout is JSON only.
`;

function requiredFlag(args, flag) {
  const value = flagValue(args, flag);
  if (value === null) fail({ code: "BAD_FLAG", message: `${flag} is required`, details: { flag } });
  return value;
}

function readRawEvent(args) {
  const eventFile = flagValue(args, "--event-file");
  const useStdin = args.includes("--event-stdin");
  if ((eventFile === null) === !useStdin) {
    fail({
      code: "IDENTITY_LINK_EVENT_SOURCE_REQUIRED",
      message: "Choose exactly one of --event-file <path> or --event-stdin",
      details: { accepted_sources: ["--event-file", "--event-stdin"] },
    });
  }
  const bytes = useStdin ? readFileSync(0) : readFileSync(eventFile);
  if (bytes.byteLength > 32 * 1024) {
    fail({ code: "IDENTITY_LINK_INVALID_JSON", message: "Raw Nostr event exceeds the 32768-byte protocol limit" });
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch {
    fail({ code: "IDENTITY_LINK_INVALID_UTF8", message: "Raw Nostr event must be valid UTF-8 JSON" });
  }
}

async function begin(args) {
  const a = normalizeArgv(args);
  const values = ["--pubkey", "--visibility", "--idempotency-key"];
  assertKnownFlags(a, [...values, "--help", "-h"], values);
  requirePositionalCount(a, values, { min: 0, max: 0, command: "run402 identity link nostr begin --pubkey <npub|hex> --visibility public" });
  const pubkey = requiredFlag(a, "--pubkey");
  const visibility = requiredFlag(a, "--visibility");
  if (visibility !== "public") {
    fail({ code: "IDENTITY_LINK_PUBLIC_VISIBILITY_REQUIRED", message: "--visibility must be exactly public; there is no private/default identity-link mode" });
  }
  try {
    const result = await getSdk({ authMode: "wallet" }).identityLinks.nostr.begin({
      nostrPubkey: pubkey,
      visibility: "public",
      idempotencyKey: flagValue(a, "--idempotency-key") ?? undefined,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { reportSdkError(error); }
}

async function complete(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--event-file", "--event-stdin", "--help", "-h"], ["--event-file"]);
  requirePositionalCount(a, ["--event-file"], { min: 0, max: 0, command: "run402 identity link nostr complete --event-file <raw-event.json>" });
  const rawEvent = readRawEvent(a);
  try {
    console.log(JSON.stringify(await getSdk({ authMode: "wallet" }).identityLinks.nostr.complete({ rawEvent }), null, 2));
  } catch (error) { reportSdkError(error); }
}

async function list(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  requirePositionalCount(a, [], { min: 0, max: 0, command: "run402 identity link list" });
  try { console.log(JSON.stringify(await getSdk().identityLinks.list(), null, 2)); }
  catch (error) { reportSdkError(error); }
}

async function show(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  const [id] = requirePositionalCount(a, [], { min: 1, max: 1, command: "run402 identity link show <identity_link_id>" });
  try { console.log(JSON.stringify(await getSdk({ authMode: "none" }).identityLinks.getProof(id), null, 2)); }
  catch (error) { reportSdkError(error); }
}

async function revoke(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  const [id] = requirePositionalCount(a, [], { min: 1, max: 1, command: "run402 identity link revoke <identity_link_id>" });
  try { console.log(JSON.stringify(await getSdk({ authMode: "wallet" }).identityLinks.revoke(id), null, 2)); }
  catch (error) { reportSdkError(error); }
}

export async function run(sub, args = []) {
  if (sub !== "link") {
    failUnknownSubcommand("identity", sub);
  }
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(HELP);
    return;
  }
  const [scope, operation, ...rest] = args;
  if (scope === "nostr" && operation === "begin") return begin(rest);
  if (scope === "nostr" && operation === "complete") return complete(rest);
  if (scope === "list") return list([operation, ...rest].filter(Boolean));
  if (scope === "show") return show([operation, ...rest].filter(Boolean));
  if (scope === "revoke") return revoke([operation, ...rest].filter(Boolean));
  if (scope === "nostr") failUnknownSubcommand("identity link nostr", operation);
  failUnknownSubcommand("identity link", scope);
}
