import { parse, evaluate, type Node, type DocumentNode, type ObjectNode, type ArrayNode, type StringNode } from "@humanwhocodes/momoa";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import { canonicalize } from "json-canonicalize";
import { LocalError } from "../errors.js";
import type { NostrEventV1 } from "./identity-links.types.js";

const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;
const EIP_SIGNATURE = /^0x[0-9a-f]{130}$/;
const HALF_N = secp256k1.Point.Fn.ORDER >> 1n;
const SECRET_FIELD = /(?:private.?key|secret|mnemonic|seed|derivation|nsec|nostr.?key)/i;
const PAYLOAD_FIELDS = [
  "action", "audience", "challenge_expires_at", "challenge_id", "issued_at", "nonce",
  "nostr_event_kind", "nostr_pubkey", "principal_id", "protocol", "visibility",
  "wallet_account", "wallet_signature_scheme",
];
const MAX_BODY_BYTES = 32 * 1024;
const MAX_CONTENT_BYTES = 8 * 1024;
const MAX_PAYLOAD_BYTES = 4 * 1024;
const encoder = new TextEncoder();

function fail(message: string, code = "IDENTITY_LINK_INVALID_EVENT", details?: Record<string, unknown>): never {
  throw new LocalError(message, "preparing Nostr identity link", { code, details });
}

function scalar(text: string, field: string): void {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("Unpaired Unicode surrogate", "IDENTITY_LINK_INVALID_JSON", { field });
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) fail("Unpaired Unicode surrogate", "IDENTITY_LINK_INVALID_JSON", { field });
  }
}

function inspect(node: Node, path = "$"): void {
  if (node.type === "Document") return inspect((node as DocumentNode).body, path);
  if (node.type === "Object") {
    const seen = new Set<string>();
    for (const member of (node as ObjectNode).members) {
      const name = member.name.type === "String" ? member.name.value : member.name.name;
      if (seen.has(name)) fail(`Duplicate JSON field: ${name}`, "IDENTITY_LINK_DUPLICATE_FIELD", { field: `${path}.${name}` });
      if (SECRET_FIELD.test(name)) fail("Secret-bearing identity-link fields are forbidden", "IDENTITY_LINK_SECRET_INPUT_FORBIDDEN", { field: `${path}.${name}` });
      seen.add(name);
      inspect(member.value, `${path}.${name}`);
    }
    return;
  }
  if (node.type === "Array") return (node as ArrayNode).elements.forEach((entry, i) => inspect(entry.value, `${path}[${i}]`));
  if (node.type === "String") scalar((node as StringNode).value, path);
}

export function parseStrictJson(text: string): unknown {
  if (text.startsWith("\ufeff")) fail("UTF-8 BOM is forbidden", "IDENTITY_LINK_INVALID_JSON");
  let ast;
  try { ast = parse(text, { mode: "json", allowTrailingCommas: false }); }
  catch { fail("Invalid JSON", "IDENTITY_LINK_INVALID_JSON"); }
  inspect(ast!);
  return evaluate(ast!);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`, "IDENTITY_LINK_INVALID_JSON", { field });
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: string[], path: string): void {
  const expected = new Set(fields);
  for (const key of Object.keys(value)) if (!expected.has(key)) fail(`Unknown field: ${key}`, "IDENTITY_LINK_UNKNOWN_FIELD", { field: `${path}.${key}` });
  for (const key of fields) if (!(key in value)) fail(`Missing field: ${key}`, "IDENTITY_LINK_INVALID_JSON", { field: `${path}.${key}` });
}

function hash(text: string): Uint8Array {
  return sha256(utf8ToBytes(text));
}

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export function normalizeNostrPublicKey(input: string): string {
  if (HEX_32.test(input)) return input;
  if (typeof input !== "string" || input !== input.toLowerCase() || !input.startsWith("npub1")) {
    fail("Nostr public key must be lowercase 64-character hex or canonical npub", "IDENTITY_LINK_INVALID_PAYLOAD");
  }
  try {
    const decoded = bech32.decode(input as `${string}1${string}`, 1000);
    const bytes = new Uint8Array(bech32.fromWords(decoded.words));
    if (decoded.prefix !== "npub" || bytes.length !== 32 || bech32.encode("npub", bech32.toWords(bytes), 1000) !== input) {
      fail("Nostr public key must be lowercase 64-character hex or canonical npub", "IDENTITY_LINK_INVALID_PAYLOAD");
    }
    return input;
  } catch {
    fail("Nostr public key must be lowercase 64-character hex or canonical npub", "IDENTITY_LINK_INVALID_PAYLOAD");
  }
}

function parseCanonicalPublicPayload(publicPayload: string): Record<string, unknown> {
  if (byteLength(publicPayload) > MAX_PAYLOAD_BYTES) fail("public_payload exceeds 4096 bytes", "IDENTITY_LINK_INVALID_PAYLOAD");
  const payload = object(parseStrictJson(publicPayload), "public_payload");
  exact(payload, PAYLOAD_FIELDS, "public_payload");
  if (canonicalize(payload) !== publicPayload) fail("public_payload is not exact RFC 8785 JSON", "IDENTITY_LINK_NONCANONICAL");
  if (
    payload.action !== "link_external_identity" ||
    payload.audience !== "https://api.run402.com/identity-links/v1" ||
    payload.protocol !== "run402.identity-link.nostr.v1" ||
    payload.visibility !== "public" ||
    payload.wallet_signature_scheme !== "eip191_personal_sign" ||
    payload.nostr_event_kind !== 1 ||
    typeof payload.nostr_pubkey !== "string" || !HEX_32.test(payload.nostr_pubkey) ||
    typeof payload.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.nonce) ||
    typeof payload.challenge_id !== "string" || !/^ilc_[A-Za-z0-9]+$/.test(payload.challenge_id) ||
    typeof payload.principal_id !== "string" || !/^prin_[A-Za-z0-9]+$/.test(payload.principal_id) ||
    typeof payload.issued_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.issued_at) ||
    typeof payload.challenge_expires_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.challenge_expires_at) ||
    Number.isNaN(Date.parse(payload.issued_at)) || Number.isNaN(Date.parse(payload.challenge_expires_at)) ||
    typeof payload.wallet_account !== "string" || !/^eip155:8453:0x[0-9A-Fa-f]{40}$/.test(payload.wallet_account)
  ) fail("public_payload does not match run402.identity-link.nostr.v1", "IDENTITY_LINK_INVALID_PAYLOAD");
  return payload;
}

export function canonicalProofContent(publicPayload: string, walletSignature: string): string {
  parseCanonicalPublicPayload(publicPayload);
  assertCanonicalWalletSignature(walletSignature);
  return canonicalize({ public_payload: publicPayload, wallet_signature: walletSignature });
}

export function assertCanonicalWalletSignature(signature: string): void {
  if (!EIP_SIGNATURE.test(signature)) fail("Wallet signature must be lowercase 65-byte 0x-prefixed hex", "IDENTITY_LINK_INVALID_WALLET_SIGNATURE");
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = signature.slice(130, 132);
  if (s === 0n || s > HALF_N || (v !== "1b" && v !== "1c")) fail("Wallet signature must be low-s with v 0x1b or 0x1c", "IDENTITY_LINK_INVALID_WALLET_SIGNATURE");
}

export function walletFromPublicPayload(publicPayload: string): string {
  const payload = parseCanonicalPublicPayload(publicPayload);
  const account = payload.wallet_account;
  if (typeof account !== "string" || !/^eip155:8453:0x[0-9A-Fa-f]{40}$/.test(account)) fail("Invalid wallet_account", "IDENTITY_LINK_INVALID_PAYLOAD");
  return account.slice("eip155:8453:".length);
}

export function verifyRawNostrEvent(input: string | NostrEventV1): NostrEventV1 {
  if (typeof input === "string" && byteLength(input) > MAX_BODY_BYTES) fail("Raw Nostr event exceeds 32768 bytes", "IDENTITY_LINK_INVALID_JSON");
  const raw = typeof input === "string" ? parseStrictJson(input) : input;
  const value = object(raw, "nostr_event");
  exact(value, ["id", "pubkey", "created_at", "kind", "tags", "content", "sig"], "nostr_event");
  const event = value as unknown as NostrEventV1;
  if (!HEX_32.test(event.id) || !HEX_32.test(event.pubkey) || !HEX_64.test(event.sig) || event.kind !== 1 || !Number.isSafeInteger(event.created_at) || event.created_at < 0 || !Array.isArray(event.tags) || typeof event.content !== "string") {
    fail("Nostr event must be the exact seven-field kind-1 envelope");
  }
  if (byteLength(event.content) > MAX_CONTENT_BYTES) fail("Nostr event content exceeds 8192 bytes");
  for (const [index, tag] of event.tags.entries()) {
    if (!Array.isArray(tag) || tag.some((item) => typeof item !== "string")) fail("Every Nostr tag must contain strings only", "IDENTITY_LINK_INVALID_EVENT", { field: `nostr_event.tags[${index}]` });
  }
  if (event.tags.length > 1) fail("Only an empty tag list or one NIP-OA auth tag is accepted");
  if (event.tags.length === 1) {
    const tag = event.tags[0];
    if (!Array.isArray(tag) || tag.length !== 4 || tag[0] !== "auth" || !HEX_32.test(tag[1] ?? "") || tag[2] !== "" || !HEX_64.test(tag[3] ?? "") || tag[1] === event.pubkey) {
      fail("Invalid NIP-OA owner-attestation tag", "IDENTITY_LINK_INVALID_NIP_OA");
    }
    if (!schnorr.verify(hexToBytes(tag[3]), hash(`nostr:agent-auth:${event.pubkey}:`), hexToBytes(tag[1]))) fail("NIP-OA owner attestation does not verify", "IDENTITY_LINK_INVALID_NIP_OA");
  }
  const wrapper = object(parseStrictJson(event.content), "nostr_event.content");
  exact(wrapper, ["public_payload", "wallet_signature"], "nostr_event.content");
  if (canonicalize(wrapper) !== event.content || typeof wrapper.public_payload !== "string" || typeof wrapper.wallet_signature !== "string") fail("Event content is not the canonical two-field proof wrapper", "IDENTITY_LINK_NONCANONICAL");
  assertCanonicalWalletSignature(wrapper.wallet_signature);
  const payload = parseCanonicalPublicPayload(wrapper.public_payload);
  if (payload.nostr_pubkey !== event.pubkey) fail("Event author and public_payload do not match", "IDENTITY_LINK_INVALID_PAYLOAD");
  const eventId = bytesToHex(hash(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])));
  if (eventId !== event.id || !schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey))) fail("Nostr event id or BIP-340 signature is invalid");
  return event;
}

export function assertNoForbiddenIdentityInput(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (SECRET_FIELD.test(key) || ["display_name", "label", "signed_label"].includes(key)) {
      fail("Nostr private keys, derivation material, and signed labels are never accepted", "IDENTITY_LINK_SECRET_INPUT_FORBIDDEN", { field: key });
    }
  }
}
