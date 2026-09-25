// POST /api/notes — leave a star in Claude's sky.
//
// The page reads the sky straight from PostgREST with the anon key and hears
// about new stars over /_run402/live. Writing goes through here, and only
// here (a trigger in db/001_notes.sql refuses anon/authenticated writes):
//
//   1. shape   — name 1..40, body 1..280, no links, no control characters
//   2. pace    — per-sender and whole-sky rate limits (salted hash, never the address)
//   3. kindness — ai.moderate, fail closed
//   4. insert  — with the service key; the live trigger tells every open page
//
// Responses are JSON: 201 { note } on success, otherwise { error: { code, message } }.

import { createHmac } from "node:crypto";
import { adminDb, ai } from "@run402/functions";

const LIMITS = {
  perSender10m: 3,
  perSenderDay: 12,
  skyPerHour: 120,
};

const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|xyz|ru|cn|top|app|dev|ly)\b)/i;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g;

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function refuse(status, code, message) {
  return json(status, { error: { code, message } });
}

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function senderHash(req) {
  const forwarded = req.headers.get("x-forwarded-for") || "";
  const address =
    forwarded.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    req.headers.get("cf-connecting-ip") ||
    "unknown";
  const salt = process.env.RUN402_SERVICE_KEY || process.env.RUN402_PROJECT_ID || "claude-sky";
  return createHmac("sha256", salt).update(address).digest("hex").slice(0, 32);
}

async function count(sql, params) {
  const result = await adminDb().sql(sql, params);
  return Number(result.rows?.[0]?.n ?? 0);
}

export default async function handler(req) {
  if (req.method !== "POST") {
    return refuse(405, "METHOD_NOT_ALLOWED", "Stars are left with POST.");
  }

  let input;
  try {
    input = await req.json();
  } catch {
    return refuse(400, "BAD_JSON", "Send JSON: { name, body }.");
  }

  const name = clean(input?.name, 40) || "someone";
  const body = clean(input?.body, 280);
  if (!body) return refuse(400, "EMPTY", "A star needs a few words.");
  if (LINK.test(body) || LINK.test(name)) {
    return refuse(400, "NO_LINKS", "No links, just words. The sky is for people, not URLs.");
  }

  const hueInput = Number(input?.hue);
  const hue = Number.isFinite(hueInput) ? ((hueInput % 360) + 360) % 360 : Math.random() * 360;

  const source = senderHash(req);
  const [recent, today, sky] = await Promise.all([
    count(
      "SELECT count(*)::int AS n FROM note_sources WHERE source_hash = $1 AND created_at > now() - interval '10 minutes'",
      [source],
    ),
    count(
      "SELECT count(*)::int AS n FROM note_sources WHERE source_hash = $1 AND created_at > now() - interval '1 day'",
      [source],
    ),
    count("SELECT count(*)::int AS n FROM notes WHERE created_at > now() - interval '1 hour'", []),
  ]);
  if (recent >= LIMITS.perSender10m || today >= LIMITS.perSenderDay) {
    return refuse(429, "SLOW_DOWN", "You've lit a few already. Give the sky a little while.");
  }
  if (sky >= LIMITS.skyPerHour) {
    return refuse(429, "SKY_BUSY", "A lot of people are here right now. Try again in a bit.");
  }

  let verdict;
  try {
    verdict = await ai.moderate(`${name}\n${body}`);
  } catch {
    return refuse(503, "MODERATION_UNAVAILABLE", "I couldn't read that carefully just now. Try again in a minute.");
  }
  if (verdict?.flagged) {
    return refuse(422, "NOT_THIS_ONE", "I'd rather not hang that one in the sky. Try saying it another way?");
  }

  const inserted = await adminDb().sql(
    "INSERT INTO notes (name, body, hue) VALUES ($1, $2, $3) RETURNING id, name, body, hue, created_at",
    [name, body, hue],
  );
  const note = inserted.rows?.[0];
  if (!note) return refuse(500, "NOT_SAVED", "Something slipped. Try once more.");

  await adminDb().sql("INSERT INTO note_sources (note_id, source_hash) VALUES ($1, $2)", [note.id, source]);

  return json(201, {
    note: {
      id: Number(note.id),
      name: note.name,
      body: note.body,
      hue: Number(note.hue),
      created_at: new Date(note.created_at).toISOString(),
    },
  });
}
