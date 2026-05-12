import { adminDb, db, getUser, email, ai } from "@run402/functions";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, role: user.role, email: user.email };
}

function keyKind(req) {
  const key = req.headers.get("apikey");
  if (!key) return "none";
  if (key === process.env.RUN402_SERVICE_KEY) return "service";
  if (key === process.env.RUN402_ANON_KEY) return "anon";
  return "unknown";
}

function rowsFromSql(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  return [];
}

function transientMessage(err) {
  const message = err instanceof Error ? err.message : String(err);
  return /\((429|500|502|503|504)\)|timeout|temporar|network/i.test(message)
    ? message
    : null;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function uploadFromFunction() {
  const text = `run402 function upload ${new Date().toISOString()}`;
  const bytes = new TextEncoder().encode(text);
  const sha256 = await sha256Hex(bytes);
  const key = `fullstack/function-${Date.now()}.txt`;
  const authHeaders = {
    apikey: process.env.RUN402_SERVICE_KEY,
    authorization: `Bearer ${process.env.RUN402_SERVICE_KEY}`,
    "content-type": "application/json",
  };

  const init = await fetch(`${process.env.RUN402_API_BASE || "https://api.run402.com"}/storage/v1/uploads`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      key,
      size_bytes: bytes.byteLength,
      content_type: "text/plain; charset=utf-8",
      visibility: "public",
      immutable: true,
      sha256,
    }),
  });
  if (!init.ok) throw new Error(`Function storage init failed (${init.status}): ${await init.text()}`);
  const session = await init.json();

  const parts = [];
  for (const part of session.parts ?? []) {
    const partBytes = bytes.subarray(part.byte_start, part.byte_end + 1);
    const put = await fetch(part.url, { method: "PUT", body: partBytes });
    if (!put.ok) throw new Error(`Function storage part failed (${put.status}): ${await put.text()}`);
    parts.push({ part_number: part.part_number, etag: put.headers.get("etag") ?? "" });
  }

  const complete = await fetch(
    `${process.env.RUN402_API_BASE || "https://api.run402.com"}/storage/v1/uploads/${session.upload_id}/complete`,
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(session.mode === "multipart" ? { parts } : {}),
    },
  );
  if (!complete.ok) throw new Error(`Function storage complete failed (${complete.status}): ${await complete.text()}`);
  const asset = await complete.json();
  return {
    key,
    text,
    sha256,
    url: asset.cdn_immutable_url ?? asset.immutable_url ?? asset.url,
    visibility: asset.visibility,
  };
}

async function handleAdminDb() {
  const inserted = rowsFromSql(await adminDb().sql(`
    INSERT INTO fs_runtime_events (kind, actor, details)
    VALUES ('admin-db', 'service', '{"source":"fullstack-direct"}'::jsonb)
    RETURNING id
  `));
  const id = inserted[0]?.id;
  await adminDb().sql(
    "UPDATE fs_runtime_events SET details = jsonb_set(details, '{updated}', 'true'::jsonb, true) WHERE id = $1",
    [id],
  );
  const rows = rowsFromSql(await adminDb().sql(
    "SELECT id, kind, actor, details, created_at, updated_at FROM fs_runtime_events WHERE id = $1",
    [id],
  ));
  return json({ ok: true, rows });
}

async function handleCallerDb(req) {
  const user = getUser(req);
  const rows = await db(req)
    .from("fs_items")
    .select("id,marker,title,done")
    .order("id")
    .limit(2);
  await adminDb().sql(
    "INSERT INTO fs_runtime_events (kind, actor, details) VALUES ('caller-db', $1, $2::jsonb)",
    [user?.email ?? "anonymous", JSON.stringify({ authenticated: !!user, keyKind: keyKind(req) })],
  );
  return json({
    ok: true,
    keyKind: keyKind(req),
    authenticated: !!user,
    user: publicUser(user),
    rows,
  });
}

async function handleSecret() {
  const value = process.env.FULLSTACK_TEST_SECRET ?? "";
  return json({ ok: true, present: value.length > 0, length: value.length });
}

async function handleEmail() {
  const to = process.env.FULLSTACK_EMAIL_TO;
  if (!to) {
    return json({ ok: true, status: "skipped", reason: "RUN402_FULLSTACK_EMAIL_TO not configured" });
  }
  try {
    const result = await email.send({
      to,
      subject: "Run402 full-stack integration",
      html: "<p>Run402 full-stack integration email path.</p>",
      text: "Run402 full-stack integration email path.",
      from_name: "Run402 Integration",
    });
    return json({ ok: true, status: "sent", id: result.id ?? result.message_id ?? null });
  } catch (err) {
    const transient = transientMessage(err);
    if (transient) return json({ ok: true, status: "skipped", reason: transient });
    throw err;
  }
}

async function handleAi() {
  try {
    const result = await ai.moderate("Run402 full-stack integration sample text.");
    return json({
      ok: true,
      status: "ok",
      flagged: result.flagged,
      categoryKeys: Object.keys(result.categories ?? {}).sort(),
    });
  } catch (err) {
    const transient = transientMessage(err);
    if (transient) return json({ ok: true, status: "skipped", reason: transient });
    throw err;
  }
}

export default async function handler(req) {
  if (req.method === "GET") {
    return json({ ok: true, keyKind: keyKind(req), user: publicUser(getUser(req)) });
  }

  const body = await readJson(req);
  switch (body.action) {
    case "admin-db":
      return handleAdminDb();
    case "caller-db":
      return handleCallerDb(req);
    case "secret":
      return handleSecret();
    case "email":
      return handleEmail();
    case "ai":
      return handleAi();
    case "storage":
      return json({ ok: true, status: "ok", asset: await uploadFromFunction() });
    default:
      return json({ ok: false, error: "unknown action" }, { status: 400 });
  }
}
