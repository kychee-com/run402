// Buzz To-Do API — one routed function behind /api/*.
//
// Sign in with Buzz, demo grade:
//   POST /api/buzz/start     → one-time challenge + buzz://nostr-bind deep link
//   POST /api/buzz/complete  → verify the kind-24243 event Buzz Desktop signed,
//                              consume the challenge, upsert the user, set a cookie
//   GET  /api/me             → who am I (from the cookie)
//   POST /api/logout         → clear the cookie
//   GET|POST|PATCH|DELETE /api/tasks → the signed-in user's tasks
//
// The verifier mirrors what Buzz Desktop signs (desktop/src-tauri/src/nostr_bind.rs):
// kind 24243, empty content, exactly nine tags in a fixed order, BIP-340 signature.
// The session is an app-minted HMAC cookie keyed off the project's service key.
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
  };
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

function setCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_S}`;
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
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
        `INSERT INTO buzz_challenges (id, nonce, verification_code, origin, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [challenge.id, challenge.nonce, challenge.verification_code, challenge.origin, challenge.expires_at],
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
      });
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
      return json({ ok: true, pubkey: event.pubkey, npub }, 200, { "set-cookie": setCookie(mintSession(event.pubkey)) });
    }

    if (path === "/api/logout" && request.method === "POST") {
      return json({ ok: true }, 200, { "set-cookie": clearCookie() });
    }

    // Everything below needs a session.
    const session = readSession(cookieValue(request));
    if (!session) return fail("UNAUTHENTICATED", "sign in with Buzz first", 401);

    if (path === "/api/me" && request.method === "GET") {
      return json({ ok: true, pubkey: session.pubkey, npub: npubFromHex(session.pubkey) });
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
