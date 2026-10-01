// Buzz To-Do API — one routed function behind /api/*.
//
// Sign in with Buzz, demo grade:
//   POST /api/buzz/start     → one-time challenge + buzz://nostr-bind deep link
//   POST /api/buzz/complete  → verify the kind-24243 event Buzz Desktop signed,
//                              consume the challenge, upsert the user, set a cookie
//   POST /api/buzz/claim     → the tab that started the challenge picks up the
//                              session after another tab completed it (device
//                              flow; this is how the Buzz pane signs in when the
//                              callback lands in the system browser)
//   GET  /api/me             → who am I (from the cookie or bearer token)
//   POST /api/logout         → clear the cookie
//   GET|POST|PATCH|DELETE /api/tasks → the signed-in user's tasks
//   POST /api/mcp            → the same tasks as MCP tools, for Buzz agents; each
//                              request is signed with NIP-98 (and, for an agent
//                              acting for its owner, a NIP-OA attestation)
//
// The verifier mirrors what Buzz Desktop signs (desktop/src-tauri/src/nostr_bind.rs):
// kind 24243, empty content, exactly nine tags in a fixed order, BIP-340 signature.
// The session is an app-minted HMAC token keyed off the project's service key,
// carried as a cookie or, where third-party cookies are blocked (the site framed
// inside Buzz Desktop), as an Authorization: Bearer header the page stores itself.
// This is intentionally NOT a Run402 tenant session — that is Idea 2's product work.

import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bech32 } from "@scure/base";

export const BUZZ_BIND_KIND = 24243;
export const BUZZ_BIND_TAG_ORDER = Object.freeze([
  "challenge_id", "nonce", "verification_code", "audience", "action",
  "protocol", "version", "origin", "expires_at",
]);
export const BUZZ_BIND_FIXED = Object.freeze({
  audience: "buzz:nostr-identity",
  action: "bind_nostr_identity",
  protocol: "buzz-nostr-identity",
  version: "1",
});
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CREATED_AT_SKEW_MS = 5 * 60 * 1000;
const SESSION_TTL_S = 7 * 24 * 60 * 60;
const COOKIE = "buzz_todo_session";
// The Buzz community relay the users live on. The app reads their kind-0
// profiles through its own member identity (BUZZ_BOT_PRIVATE_KEY, a project
// secret) with NIP-98 auth; without the secret the app shows the npub only.
const BUZZ_RELAY_ORIGIN = process.env.BUZZ_RELAY_ORIGIN || "https://kychee.communities.buzz.xyz";
const PROFILE_TTL_MS = 10 * 60 * 1000;
const NIP98_KIND = 27235;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export class BuzzBindError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Pure verification — no I/O, exported so it can be tested without the runtime.
// ---------------------------------------------------------------------------

export function npubFromHex(pubkeyHex) {
  return bech32.encode("npub", bech32.toWords(Buffer.from(pubkeyHex, "hex")), 1000);
}

export function computeEventId(event) {
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// The app's own Buzz identity: signs NIP-98 requests to read user profiles.
// ---------------------------------------------------------------------------

export function signNostrEvent(privHex, kind, tags, content, createdAt = Math.floor(Date.now() / 1000)) {
  const priv = Buffer.from(privHex, "hex");
  const event = { pubkey: Buffer.from(schnorr.getPublicKey(priv)).toString("hex"), created_at: createdAt, kind, tags, content };
  event.id = computeEventId(event);
  event.sig = Buffer.from(schnorr.sign(Buffer.from(event.id, "hex"), priv)).toString("hex");
  return event;
}

export function nip98Authorization(privHex, url, method, body) {
  const tags = [["u", url], ["method", method.toUpperCase()]];
  if (body !== undefined) tags.push(["payload", createHash("sha256").update(body, "utf8").digest("hex")]);
  const event = signNostrEvent(privHex, NIP98_KIND, tags, "");
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}`;
}

/** Blossom (BUD-01) `get` authorization for one relay media object. */
export function blossomGetAuthorization(privHex, mediaUrl, nowS = Math.floor(Date.now() / 1000)) {
  const url = new URL(mediaUrl);
  const file = url.pathname.split("/").pop() ?? "";
  const sha256 = file.split(".")[0];
  const tags = [["t", "get"], ["expiration", String(nowS + 600)], ["server", url.host]];
  if (HEX64.test(sha256)) tags.push(["x", sha256]);
  const event = signNostrEvent(privHex, 24242, tags, "Get media", nowS);
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}`;
}

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** Fetch a relay-hosted image through the app's member identity. null when unavailable. */
export async function fetchRelayMedia(mediaUrl, { privHex = process.env.BUZZ_BOT_PRIVATE_KEY, origin = BUZZ_RELAY_ORIGIN } = {}) {
  if (!privHex || !HEX64.test(privHex)) return null;
  let url;
  try { url = new URL(mediaUrl); } catch { return null; }
  if (url.origin !== origin || !url.pathname.startsWith("/media/")) return null;
  let res;
  try {
    res = await fetch(url, { headers: { authorization: blossomGetAuthorization(privHex, url.toString()), accept: "image/*" }, signal: AbortSignal.timeout(8000) });
  } catch (error) {
    console.warn("relay media fetch failed", { url: url.toString(), error: String(error?.message ?? error) });
    return null;
  }
  if (!res.ok) {
    console.warn("relay media fetch rejected", { url: url.toString(), status: res.status });
    return null;
  }
  const type = res.headers.get("content-type") || "application/octet-stream";
  if (!type.startsWith("image/")) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > AVATAR_MAX_BYTES) return null;
  return { bytes: buf, contentType: type };
}

/** Kind-0 profile for a pubkey from the Buzz relay, or null when unavailable. */
export async function fetchBuzzProfile(pubkey, { privHex = process.env.BUZZ_BOT_PRIVATE_KEY, origin = BUZZ_RELAY_ORIGIN } = {}) {
  if (!privHex || !HEX64.test(privHex)) return null;
  const url = `${origin}/query`;
  const body = JSON.stringify([{ kinds: [0], authors: [pubkey], limit: 1 }]);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: nip98Authorization(privHex, url, "POST", body) },
      body,
      signal: AbortSignal.timeout(6000),
    });
  } catch (error) {
    console.warn("buzz profile fetch failed", { pubkey, error: String(error?.message ?? error) });
    return null;
  }
  if (!res.ok) {
    console.warn("buzz profile fetch rejected", { pubkey, status: res.status, body: (await res.text().catch(() => "")).slice(0, 200) });
    return null;
  }
  const events = await res.json().catch(() => null);
  const event = Array.isArray(events) ? events.find((e) => e && e.kind === 0 && e.pubkey === pubkey) : null;
  if (!event) return null;
  let meta;
  try { meta = JSON.parse(event.content); } catch { return null; }
  if (!meta || typeof meta !== "object") return null;
  const pick = (k) => (typeof meta[k] === "string" && meta[k].trim() ? meta[k].trim().slice(0, 500) : null);
  return { display_name: pick("display_name"), name: pick("name"), picture: pick("picture"), about: pick("about"), nip05: pick("nip05") };
}

function exactTags(tags) {
  if (tags.length !== BUZZ_BIND_TAG_ORDER.length || tags.some((tag, i) => tag[0] !== BUZZ_BIND_TAG_ORDER[i])) {
    throw new BuzzBindError("BUZZ_PROOF_INVALID", "event tag order or fields are invalid");
  }
  const out = {};
  for (const tag of tags) {
    if (tag.length !== 2) throw new BuzzBindError("BUZZ_PROOF_INVALID", `tag ${tag[0]} must be [name, value]`);
    if (out[tag[0]] !== undefined) throw new BuzzBindError("BUZZ_PROOF_INVALID", `duplicate ${tag[0]} tag`);
    out[tag[0]] = tag[1];
  }
  return out;
}

/** Shape + signature only. Returns the parsed tags. */
export function verifyBuzzBindEvent(event, nowMs = Date.now()) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new BuzzBindError("BUZZ_PROOF_INVALID", "event must be a Nostr event object");
  }
  if (Object.keys(event).sort().join(",") !== "content,created_at,id,kind,pubkey,sig,tags") {
    throw new BuzzBindError("BUZZ_PROOF_INVALID", "event must have exactly the seven NIP-01 fields");
  }
  if (!HEX64.test(event.id) || !HEX64.test(event.pubkey) || !HEX128.test(event.sig)) {
    throw new BuzzBindError("BUZZ_PROOF_INVALID", "event id, pubkey, or sig is malformed");
  }
  if (!Number.isSafeInteger(event.created_at) || event.created_at < 0) {
    throw new BuzzBindError("BUZZ_PROOF_INVALID", "event created_at is invalid");
  }
  if (event.kind !== BUZZ_BIND_KIND || event.content !== "") {
    throw new BuzzBindError("BUZZ_PROOF_INVALID", "event kind or content is not a Buzz identity binding");
  }
  if (!Array.isArray(event.tags) || event.tags.some((t) => !Array.isArray(t) || t.some((p) => typeof p !== "string"))) {
    throw new BuzzBindError("BUZZ_PROOF_INVALID", "event tags must be arrays of strings");
  }
  const tags = exactTags(event.tags);
  for (const [name, value] of Object.entries(BUZZ_BIND_FIXED)) {
    if (tags[name] !== value) throw new BuzzBindError("BUZZ_PROOF_INVALID", `event ${name} is not ${value}`);
  }
  if (Math.abs(event.created_at * 1000 - nowMs) > CREATED_AT_SKEW_MS) {
    throw new BuzzBindError("BUZZ_PROOF_STALE", "event created_at is not fresh");
  }
  if (computeEventId(event) !== event.id) {
    throw new BuzzBindError("BUZZ_PROOF_INVALID", "event id does not match its contents");
  }
  let ok = false;
  try {
    ok = schnorr.verify(Buffer.from(event.sig, "hex"), Buffer.from(event.id, "hex"), Buffer.from(event.pubkey, "hex"));
  } catch {
    ok = false;
  }
  if (!ok) throw new BuzzBindError("BUZZ_PROOF_INVALID", "event signature is invalid");
  return tags;
}

/** The event's tags must echo the stored challenge exactly. */
export function assertTagsMatchChallenge(tags, challenge, nowMs = Date.now()) {
  if (tags.challenge_id !== challenge.id || tags.nonce !== challenge.nonce
      || tags.verification_code !== challenge.verification_code
      || tags.origin !== challenge.origin || tags.expires_at !== challenge.expires_at) {
    throw new BuzzBindError("BUZZ_PROOF_MISMATCH", "event does not match the active challenge");
  }
  const expiresMs = Date.parse(challenge.expires_at);
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
    throw new BuzzBindError("BUZZ_CHALLENGE_EXPIRED", "challenge expired; start again", 409);
  }
}

export function buildDeepLink(challenge, callbackUrl) {
  const url = new URL("buzz://nostr-bind");
  url.searchParams.set("challenge_id", challenge.id);
  url.searchParams.set("nonce", challenge.nonce);
  url.searchParams.set("verification_code", challenge.verification_code);
  url.searchParams.set("audience", BUZZ_BIND_FIXED.audience);
  url.searchParams.set("action", BUZZ_BIND_FIXED.action);
  url.searchParams.set("protocol", BUZZ_BIND_FIXED.protocol);
  url.searchParams.set("version", BUZZ_BIND_FIXED.version);
  url.searchParams.set("origin", challenge.origin);
  url.searchParams.set("expires_at", challenge.expires_at);
  url.searchParams.set("return", "browser_fragment_v1");
  url.searchParams.set("callback_url", callbackUrl);
  return url.toString();
}

export function newChallenge(origin, nowMs = Date.now()) {
  return {
    id: randomUUID(),
    nonce: randomBytes(32).toString("base64url"), // 43 chars, Buzz's exact nonce alphabet
    verification_code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
    origin,
    expires_at: new Date(nowMs + CHALLENGE_TTL_MS).toISOString(),
    // Held by the starting tab only; never part of the deep link or the signed event.
    claim_token: randomBytes(32).toString("base64url"),
  };
}

export function hashClaimToken(token) {
  return createHash("sha256").update(`buzz-todo-claim:${token}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Session cookie — HMAC over "v1.<pubkey>.<exp>", keyed off the service key.
// ---------------------------------------------------------------------------

function sessionKey() {
  const serviceKey = process.env.RUN402_SERVICE_KEY;
  if (!serviceKey) throw new Error("RUN402_SERVICE_KEY is required to mint sessions");
  return createHash("sha256").update(`buzz-todo-session:${serviceKey}`).digest();
}

export function mintSession(pubkey, nowMs = Date.now(), key = sessionKey()) {
  const exp = Math.floor(nowMs / 1000) + SESSION_TTL_S;
  const payload = `v1.${pubkey}.${exp}`;
  const mac = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function readSession(token, nowMs = Date.now(), key = sessionKey()) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !HEX64.test(parts[1])) return null;
  const exp = Number(parts[2]);
  if (!Number.isSafeInteger(exp) || exp * 1000 <= nowMs) return null;
  const expected = createHmac("sha256", key).update(`v1.${parts[1]}.${exp}`).digest();
  const actual = Buffer.from(parts[3], "base64url");
  if (actual.toString("base64url") !== parts[3]) return null; // canonical encoding only
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return { pubkey: parts[1], exp };
}

function cookieValue(request) {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return null;
}

/** Bearer first (the page chose to send it), then the cookie. */
function sessionToken(request) {
  const auth = request.headers.get("authorization") ?? "";
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return cookieValue(request);
}

// ---------------------------------------------------------------------------
// Agent entrance: NIP-98 HTTP auth, optionally with a NIP-OA owner attestation.
// A Buzz agent signs each request with its own key; when the event carries a
// valid `auth` tag from its owner, the agent works on the owner's list. The
// event id is single-use (buzz_nostr_auth_seen), so a captured header cannot
// be replayed even inside the freshness window.
// ---------------------------------------------------------------------------

const NIP98_SKEW_MS = 60 * 1000;
const NIP98_MAX_HEADER = 16 * 1024;
const NIP98_TAGS = new Set(["u", "method", "payload", "auth"]);
const DECIMAL = /^(0|[1-9][0-9]*)$/;

function authError(code, message) {
  return new BuzzBindError(code, message, 401);
}

function verifySignature(sig, digestHex, pubkey) {
  try {
    return schnorr.verify(Buffer.from(sig, "hex"), Buffer.from(digestHex, "hex"), Buffer.from(pubkey, "hex"));
  } catch {
    return false;
  }
}

/** NIP-OA conditions, evaluated exactly as the NIP defines them. */
function attestationConditionsHold(conditions, event) {
  if (conditions === "") return true;
  if (!/^[\x21-\x7e]+$/.test(conditions)) return false;
  for (const clause of conditions.split("&")) {
    let match;
    if ((match = /^kind=(.+)$/.exec(clause))) {
      if (!DECIMAL.test(match[1]) || Number(match[1]) > 65535) return false;
      if (event.kind !== Number(match[1])) return false;
    } else if ((match = /^created_at([<>])(.+)$/.exec(clause))) {
      if (!DECIMAL.test(match[2]) || Number(match[2]) > 4294967295) return false;
      const t = Number(match[2]);
      if (match[1] === "<" ? !(event.created_at < t) : !(event.created_at > t)) return false;
    } else {
      return false;
    }
  }
  return true;
}

/** The owner a NIP-OA `auth` tag names, or null when the event carries none. Throws when invalid. */
export function verifyOwnerAttestation(event) {
  const tags = event.tags.filter((t) => t[0] === "auth");
  if (tags.length === 0) return null;
  const [tag] = tags;
  if (tags.length !== 1 || tag.length !== 4) throw authError("NOSTR_AUTH_ATTESTATION_INVALID", "exactly one four-element auth tag is allowed");
  const [, owner, conditions, sig] = tag;
  if (!HEX64.test(owner) || !HEX128.test(sig) || owner === event.pubkey) {
    throw authError("NOSTR_AUTH_ATTESTATION_INVALID", "auth tag owner or signature is malformed");
  }
  const digest = createHash("sha256").update(`nostr:agent-auth:${event.pubkey}:${conditions}`, "utf8").digest("hex");
  if (!verifySignature(sig, digest, owner)) throw authError("NOSTR_AUTH_ATTESTATION_INVALID", "auth tag is not signed by its owner");
  if (!attestationConditionsHold(conditions, event)) throw authError("NOSTR_AUTH_ATTESTATION_INVALID", "auth tag conditions do not cover this request");
  return owner;
}

/**
 * Verify `Authorization: Nostr <base64 event>` for one request. Returns
 * `{ event, actor, owner, user }`; `user` is whose list the request works on.
 * Does not check replay; the caller records `event.id` as used.
 */
export function verifyNip98Request(header, { url, method, body, nowMs = Date.now() }) {
  const match = /^Nostr\s+([A-Za-z0-9+/=]+)$/.exec(header ?? "");
  if (!match || match[1].length > NIP98_MAX_HEADER) throw authError("NOSTR_AUTH_REQUIRED", "send Authorization: Nostr <base64 kind-27235 event>");
  let event;
  try {
    event = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  } catch {
    throw authError("NOSTR_AUTH_INVALID", "authorization event is not base64 JSON");
  }
  if (!event || typeof event !== "object" || Array.isArray(event)
      || Object.keys(event).sort().join(",") !== "content,created_at,id,kind,pubkey,sig,tags") {
    throw authError("NOSTR_AUTH_INVALID", "authorization event must have exactly the seven NIP-01 fields");
  }
  if (!HEX64.test(event.id) || !HEX64.test(event.pubkey) || !HEX128.test(event.sig)
      || !Number.isSafeInteger(event.created_at) || event.kind !== NIP98_KIND || event.content !== ""
      || !Array.isArray(event.tags) || event.tags.some((t) => !Array.isArray(t) || t.length < 2 || t.some((p) => typeof p !== "string"))) {
    throw authError("NOSTR_AUTH_INVALID", "authorization event is not a NIP-98 event");
  }
  const single = {};
  for (const tag of event.tags) {
    if (!NIP98_TAGS.has(tag[0])) throw authError("NOSTR_AUTH_INVALID", `unexpected ${tag[0]} tag`);
    if (tag[0] === "auth") continue;
    if (tag.length !== 2 || single[tag[0]] !== undefined) throw authError("NOSTR_AUTH_INVALID", `exactly one two-element ${tag[0]} tag is required`);
    single[tag[0]] = tag[1];
  }
  if (Math.abs(event.created_at * 1000 - nowMs) > NIP98_SKEW_MS) throw authError("NOSTR_AUTH_STALE", "authorization event created_at is not within 60 seconds");
  if (single.u !== url) throw authError("NOSTR_AUTH_MISMATCH", `u tag must be ${url}`);
  if (single.method !== method) throw authError("NOSTR_AUTH_MISMATCH", `method tag must be ${method}`);
  const payload = createHash("sha256").update(body, "utf8").digest("hex");
  if (single.payload !== payload) throw authError("NOSTR_AUTH_MISMATCH", "payload tag must be the SHA-256 of the request body");
  if (computeEventId(event) !== event.id) throw authError("NOSTR_AUTH_INVALID", "authorization event id does not match its contents");
  if (!verifySignature(event.sig, event.id, event.pubkey)) throw authError("NOSTR_AUTH_INVALID", "authorization event signature is invalid");
  const owner = verifyOwnerAttestation(event);
  return { event, actor: event.pubkey, owner, user: owner ?? event.pubkey };
}

// ---------------------------------------------------------------------------
// MCP (streamable HTTP, single JSON responses) over the same task store.
// ---------------------------------------------------------------------------

export const MCP_PROTOCOL_VERSIONS = Object.freeze(["2025-06-18", "2025-03-26", "2024-11-05"]);
const TASK_ID = { type: "string", description: "Task id from list_tasks" };
export const MCP_TOOLS = Object.freeze([
  {
    name: "list_tasks",
    title: "List tasks",
    description: "List the to-do items on the shared list, oldest first.",
    inputSchema: { type: "object", properties: { include_done: { type: "boolean", description: "Include completed tasks (default true)" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_task",
    title: "Add task",
    description: "Add a to-do item to the shared list.",
    inputSchema: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 200 } }, required: ["title"], additionalProperties: false },
  },
  {
    name: "complete_task",
    title: "Mark task done",
    description: "Mark a to-do item done, or not done with done=false.",
    inputSchema: { type: "object", properties: { id: TASK_ID, done: { type: "boolean", description: "Default true" } }, required: ["id"], additionalProperties: false },
    annotations: { idempotentHint: true },
  },
  {
    name: "delete_task",
    title: "Delete task",
    description: "Delete a to-do item from the shared list.",
    inputSchema: { type: "object", properties: { id: TASK_ID }, required: ["id"], additionalProperties: false },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError };
}

async function callTool(name, args, tasks) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return toolResult({ error: "arguments must be an object" }, true);
  const tool = MCP_TOOLS.find((t) => t.name === name);
  const unknown = tool && Object.keys(args).find((k) => !(k in tool.inputSchema.properties));
  if (unknown) return toolResult({ error: `unknown argument ${unknown}` }, true);
  if (name === "list_tasks") {
    if (args.include_done !== undefined && typeof args.include_done !== "boolean") return toolResult({ error: "include_done must be a boolean" }, true);
    const all = await tasks.list();
    return toolResult({ tasks: args.include_done === false ? all.filter((t) => !t.done) : all });
  }
  if (name === "add_task") {
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title || title.length > 200) return toolResult({ error: "title must be 1-200 characters" }, true);
    return toolResult({ task: await tasks.add(title) });
  }
  if (name === "complete_task" || name === "delete_task") {
    if (typeof args.id !== "string" || !UUID.test(args.id)) return toolResult({ error: "id must be a task id from list_tasks" }, true);
    if (name === "delete_task") {
      return (await tasks.remove(args.id)) ? toolResult({ deleted: args.id }) : toolResult({ error: "no such task" }, true);
    }
    if (args.done !== undefined && typeof args.done !== "boolean") return toolResult({ error: "done must be a boolean" }, true);
    const task = await tasks.setDone(args.id, args.done ?? true);
    return task ? toolResult({ task }) : toolResult({ error: "no such task" }, true);
  }
  return null;
}

/**
 * One JSON-RPC message → one response object, or null for a notification.
 * `tasks` is the task store already scoped to the authenticated user.
 */
export async function mcpDispatch(message, tasks) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message?.id ?? null, -32600, "expected one JSON-RPC 2.0 request");
  }
  const { id, method, params } = message;
  if (id === undefined) return null; // notifications/initialized and friends
  if (method === "initialize") {
    const asked = params?.protocolVersion;
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: "buzz-todo", title: "Buzz To-Do", version: "1.0.0" },
      instructions: "A shared to-do list. An agent signed with its owner's attestation works on its owner's list.",
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: MCP_TOOLS });
  if (method === "tools/call") {
    const result = await callTool(params?.name, params?.arguments ?? {}, tasks);
    return result ? rpcResult(id, result) : rpcError(id, -32602, `unknown tool ${params?.name}`);
  }
  return rpcError(id, -32601, `method ${method} is not supported`);
}

function taskStore(db, pubkey) {
  const columns = "id, title, done, created_at";
  return {
    list: async () => (await db.sql(`SELECT ${columns} FROM tasks WHERE pubkey = $1 ORDER BY created_at`, [pubkey])).rows,
    add: async (title) => (await db.sql(`INSERT INTO tasks (pubkey, title) VALUES ($1, $2) RETURNING ${columns}`, [pubkey, title])).rows[0],
    setDone: async (id, done) => (await db.sql(`UPDATE tasks SET done = $3 WHERE id = $1::uuid AND pubkey = $2 RETURNING ${columns}`, [id, pubkey, done])).rows[0] ?? null,
    remove: async (id) => (await db.sql(`DELETE FROM tasks WHERE id = $1::uuid AND pubkey = $2 RETURNING id`, [id, pubkey])).rows.length === 1,
  };
}

export async function serveMcp(request, ctx, db) {
  const url = `${publicOrigin(request, ctx)}/api/mcp`;
  const body = await request.text();
  if (body.length > 64 * 1024) return fail("MCP_BODY_TOO_LARGE", "request body is too large", 413);
  let auth;
  try {
    auth = verifyNip98Request(request.headers.get("authorization"), { url, method: "POST", body });
  } catch (error) {
    if (!(error instanceof BuzzBindError)) throw error;
    return json({ ok: false, code: error.code, message: error.message }, 401, { "www-authenticate": "Nostr" });
  }
  const fresh = await db.sql(
    `INSERT INTO buzz_nostr_auth_seen (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
    [auth.event.id],
  );
  if (fresh.rows.length !== 1) return json({ ok: false, code: "NOSTR_AUTH_REPLAYED", message: "this authorization event was already used" }, 401, { "www-authenticate": "Nostr" });
  await db.sql(`DELETE FROM buzz_nostr_auth_seen WHERE seen_at < now() - interval '10 minutes'`);
  let message;
  try {
    message = JSON.parse(body);
  } catch {
    return json(rpcError(null, -32700, "body is not JSON"));
  }
  await db.sql(
    `INSERT INTO buzz_users (pubkey, npub) VALUES ($1, $2) ON CONFLICT (pubkey) DO NOTHING`,
    [auth.user, npubFromHex(auth.user)],
  );
  const response = await mcpDispatch(message, taskStore(db, auth.user));
  return response ? json(response) : new Response(null, { status: 202 });
}

function setCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_S}`;
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// User rows + cached profile
// ---------------------------------------------------------------------------

const USER_COLUMNS = "pubkey, npub, display_name, name, picture, about, nip05, profile_fetched_at";

async function loadUser(db, pubkey) {
  const r = await db.sql(`SELECT ${USER_COLUMNS} FROM buzz_users WHERE pubkey = $1`, [pubkey]);
  return r.rows[0] ?? null;
}

/** Best-effort: refresh the cached kind-0 profile when stale or forced. Never throws. */
async function refreshProfile(db, user, { force = false } = {}) {
  const fetchedAt = user.profile_fetched_at ? Date.parse(user.profile_fetched_at) : 0;
  if (!force && Date.now() - fetchedAt < PROFILE_TTL_MS) return user;
  const profile = await fetchBuzzProfile(user.pubkey);
  if (!profile) return user;
  try {
    const r = await db.sql(
      `UPDATE buzz_users SET display_name = $2, name = $3, picture = $4, about = $5, nip05 = $6, profile_fetched_at = now()
        WHERE pubkey = $1 RETURNING ${USER_COLUMNS}`,
      [user.pubkey, profile.display_name, profile.name, profile.picture, profile.about, profile.nip05],
    );
    return r.rows[0] ?? user;
  } catch (error) {
    console.warn("profile cache write failed", { pubkey: user.pubkey, error: String(error?.message ?? error) });
    return user;
  }
}

function presentUser(user) {
  const npub = user.npub || npubFromHex(user.pubkey);
  const label = user.display_name || user.name || `${npub.slice(0, 12)}…${npub.slice(-6)}`;
  return {
    pubkey: user.pubkey,
    npub,
    label,
    display_name: user.display_name ?? null,
    name: user.name ?? null,
    picture: user.picture ?? null,
    about: user.about ?? null,
    nip05: user.nip05 ?? null,
    profile_source: user.profile_fetched_at ? "buzz" : "none",
  };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

function fail(code, message, status = 400) {
  return json({ ok: false, code, message }, status);
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function publicOrigin(request, ctx) {
  const host = ctx.host || new URL(request.url).host;
  return `https://${host}`;
}

export default async function handler(request) {
  const { adminDb, getRun402Context } = await import("@run402/functions");
  const ctx = getRun402Context(request);
  const path = new URL(request.url).pathname;
  const db = adminDb();

  try {
    if (path === "/api/buzz/start" && request.method === "POST") {
      const origin = publicOrigin(request, ctx);
      const challenge = newChallenge(origin);
      await db.sql(
        `INSERT INTO buzz_challenges (id, nonce, verification_code, origin, expires_at, claim_token_hash)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [challenge.id, challenge.nonce, challenge.verification_code, challenge.origin, challenge.expires_at, hashClaimToken(challenge.claim_token)],
      );
      // Opportunistic sweep of stale challenges.
      await db.sql(`DELETE FROM buzz_challenges WHERE created_at < now() - interval '1 hour'`);
      const callbackUrl = `${origin}/callback`;
      return json({
        ok: true,
        challenge_id: challenge.id,
        verification_code: challenge.verification_code,
        expires_at: challenge.expires_at,
        deep_link: buildDeepLink(challenge, callbackUrl),
        callback_url: callbackUrl,
        claim_token: challenge.claim_token,
      });
    }

    if (path === "/api/buzz/claim" && request.method === "POST") {
      // Device-flow pickup: the starting tab polls with its private claim token.
      // 202 until the callback tab has consumed the challenge; one claim only.
      const { challenge_id, claim_token } = await readJson(request);
      if (typeof challenge_id !== "string" || !/^[0-9a-f-]{36}$/i.test(challenge_id) || typeof claim_token !== "string" || !claim_token) {
        return fail("BUZZ_CLAIM_INVALID", "challenge_id and claim_token are required");
      }
      const found = await db.sql(
        `SELECT id, expires_at, consumed_at, claimed_at, pubkey, claim_token_hash
           FROM buzz_challenges WHERE id = $1::uuid`,
        [challenge_id],
      );
      const challenge = found.rows[0];
      if (!challenge || !challenge.claim_token_hash) return fail("BUZZ_CHALLENGE_UNKNOWN", "no such challenge; start again", 404);
      const expected = Buffer.from(challenge.claim_token_hash, "hex");
      const actual = Buffer.from(hashClaimToken(claim_token), "hex");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return fail("BUZZ_CHALLENGE_UNKNOWN", "no such challenge; start again", 404);
      }
      if (challenge.claimed_at) return fail("BUZZ_CLAIM_REPLAYED", "this sign-in was already picked up", 409);
      if (!challenge.consumed_at || !HEX64.test(challenge.pubkey ?? "")) {
        if (Date.parse(challenge.expires_at) <= Date.now()) return fail("BUZZ_CHALLENGE_EXPIRED", "challenge expired; start again", 410);
        return json({ ok: true, pending: true }, 202);
      }
      const claimed = await db.sql(
        `UPDATE buzz_challenges SET claimed_at = now()
          WHERE id = $1::uuid AND claimed_at IS NULL RETURNING pubkey`,
        [challenge.id],
      );
      if (claimed.rows.length !== 1) return fail("BUZZ_CLAIM_REPLAYED", "this sign-in was already picked up", 409);
      const pubkey = claimed.rows[0].pubkey;
      const npub = npubFromHex(pubkey);
      const user = presentUser(await refreshProfile(db, (await loadUser(db, pubkey)) ?? { pubkey, npub }));
      const token = mintSession(pubkey);
      return json({ ok: true, pending: false, pubkey, npub, user, session_token: token }, 200, { "set-cookie": setCookie(token) });
    }

    if (path === "/api/buzz/complete" && request.method === "POST") {
      const { event } = await readJson(request);
      const tags = verifyBuzzBindEvent(event);
      const found = await db.sql(
        `SELECT id, nonce, verification_code, origin, expires_at, consumed_at
           FROM buzz_challenges WHERE id = $1::uuid`,
        [tags.challenge_id],
      );
      const challenge = found.rows[0];
      if (!challenge) return fail("BUZZ_CHALLENGE_UNKNOWN", "no such challenge; start again", 404);
      if (challenge.consumed_at) return fail("BUZZ_CHALLENGE_REPLAYED", "this approval was already used", 409);
      assertTagsMatchChallenge(tags, challenge);
      // Atomic single-use consumption.
      const consumed = await db.sql(
        `UPDATE buzz_challenges SET consumed_at = now(), pubkey = $2
          WHERE id = $1::uuid AND consumed_at IS NULL RETURNING id`,
        [challenge.id, event.pubkey],
      );
      if (consumed.rows.length !== 1) return fail("BUZZ_CHALLENGE_REPLAYED", "this approval was already used", 409);
      const npub = npubFromHex(event.pubkey);
      await db.sql(
        `INSERT INTO buzz_users (pubkey, npub) VALUES ($1, $2)
         ON CONFLICT (pubkey) DO UPDATE SET last_login_at = now()`,
        [event.pubkey, npub],
      );
      const user = presentUser(await refreshProfile(db, (await loadUser(db, event.pubkey)) ?? { pubkey: event.pubkey, npub }, { force: true }));
      return json({ ok: true, pubkey: event.pubkey, npub, user }, 200, { "set-cookie": setCookie(mintSession(event.pubkey)) });
    }

    if (path === "/api/logout" && request.method === "POST") {
      return json({ ok: true }, 200, { "set-cookie": clearCookie() });
    }

    if (path === "/api/mcp" && request.method === "POST") {
      return await serveMcp(request, ctx, db);
    }

    // Everything below needs a session.
    const session = readSession(sessionToken(request));
    if (!session) return fail("UNAUTHENTICATED", "sign in with Buzz first", 401);

    if (path === "/api/avatar" && request.method === "GET") {
      // Relay media needs a Blossom token, which browsers cannot mint; the app
      // fetches it with its own member identity and streams the bytes.
      const target = new URL(request.url).searchParams.get("u") || session.pubkey;
      if (!HEX64.test(target)) return fail("AVATAR_INVALID", "u must be a hex pubkey");
      const row = await loadUser(db, target);
      const picture = row?.picture;
      if (!picture) return fail("AVATAR_NONE", "no picture", 404);
      let pictureUrl;
      try { pictureUrl = new URL(picture); } catch { return fail("AVATAR_NONE", "no picture", 404); }
      if (pictureUrl.protocol !== "https:") return fail("AVATAR_NONE", "no picture", 404);
      if (pictureUrl.origin !== BUZZ_RELAY_ORIGIN) {
        return new Response(null, { status: 302, headers: { location: pictureUrl.toString(), "cache-control": "private, max-age=600" } });
      }
      const media = await fetchRelayMedia(pictureUrl.toString());
      if (!media) return fail("AVATAR_UNAVAILABLE", "could not fetch the picture", 502);
      return new Response(media.bytes, {
        status: 200,
        headers: { "content-type": media.contentType, "cache-control": "private, max-age=600", "x-content-type-options": "nosniff" },
      });
    }

    if (path === "/api/me" && request.method === "GET") {
      const row = (await loadUser(db, session.pubkey)) ?? { pubkey: session.pubkey, npub: npubFromHex(session.pubkey) };
      const user = presentUser(await refreshProfile(db, row));
      return json({ ok: true, ...user, user });
    }

    if (path === "/api/tasks") {
      if (request.method === "GET") {
        const r = await db.sql(
          `SELECT id, title, done, created_at FROM tasks WHERE pubkey = $1 ORDER BY created_at`,
          [session.pubkey],
        );
        return json({ ok: true, tasks: r.rows });
      }
      if (request.method === "POST") {
        const { title } = await readJson(request);
        const clean = typeof title === "string" ? title.trim() : "";
        if (!clean || clean.length > 200) return fail("TASK_TITLE_INVALID", "title must be 1–200 characters");
        const r = await db.sql(
          `INSERT INTO tasks (pubkey, title) VALUES ($1, $2) RETURNING id, title, done, created_at`,
          [session.pubkey, clean],
        );
        return json({ ok: true, task: r.rows[0] }, 201);
      }
      if (request.method === "PATCH") {
        const { id, done } = await readJson(request);
        if (typeof id !== "string" || typeof done !== "boolean") return fail("TASK_PATCH_INVALID", "id and done are required");
        const r = await db.sql(
          `UPDATE tasks SET done = $3 WHERE id = $1::uuid AND pubkey = $2 RETURNING id, title, done, created_at`,
          [id, session.pubkey, done],
        );
        if (!r.rows.length) return fail("TASK_NOT_FOUND", "no such task", 404);
        return json({ ok: true, task: r.rows[0] });
      }
      if (request.method === "DELETE") {
        const { id } = await readJson(request);
        if (typeof id !== "string") return fail("TASK_DELETE_INVALID", "id is required");
        const r = await db.sql(
          `DELETE FROM tasks WHERE id = $1::uuid AND pubkey = $2 RETURNING id`,
          [id, session.pubkey],
        );
        if (!r.rows.length) return fail("TASK_NOT_FOUND", "no such task", 404);
        return json({ ok: true, id });
      }
    }

    return fail("NOT_FOUND", `no handler for ${request.method} ${path}`, 404);
  } catch (error) {
    if (error instanceof BuzzBindError) return fail(error.code, error.message, error.status);
    console.error("buzz-todo-api failed", { path, method: request.method, error: String(error?.message ?? error) });
    return fail("INTERNAL", "something went wrong", 500);
  }
}
