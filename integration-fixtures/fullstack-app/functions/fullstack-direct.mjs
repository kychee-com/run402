import { adminDb, db, getUser, email, ai, assets, routedHttp } from "@run402/functions";

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

async function uploadFromFunction() {
  const stamp = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const key = `fullstack/fn-${stamp}.txt`;
  const body = `run402 function upload ${stamp}`;
  const asset = await assets.put(key, body, {
    contentType: "text/plain; charset=utf-8",
  });
  return {
    status: "ok",
    key: asset.key,
    url: asset.url,
    immutableUrl: asset.immutableUrl,
    cdnUrl: asset.cdnUrl,
    sha256: asset.sha256,
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

async function handleAiTranslate() {
  try {
    const result = await ai.translate("hello", "es");
    return json({
      ok: true,
      status: "ok",
      to: result.to,
      has_text: typeof result.text === "string" && result.text.length > 0,
    });
  } catch (err) {
    const transient = transientMessage(err);
    if (transient) return json({ ok: true, status: "skipped", reason: transient });
    throw err;
  }
}

async function handleAiGenerateImage() {
  try {
    const result = await ai.generateImage({ prompt: "a blue circle on white background", aspect: "square" });
    return json({
      ok: true,
      status: "ok",
      aspect: result.aspect,
      content_type: result.content_type,
      has_image: typeof result.image === "string" && result.image.length > 0,
    });
  } catch (err) {
    const transient = transientMessage(err);
    if (transient) return json({ ok: true, status: "skipped", reason: transient });
    throw err;
  }
}

async function handleAdminDbFrom() {
  const rows = await adminDb().from("fs_items").select("id,marker").limit(2);
  return json({ ok: true, rows });
}

async function handleEmailTemplate() {
  const to = process.env.FULLSTACK_EMAIL_TO;
  const template = process.env.FULLSTACK_EMAIL_TEMPLATE;
  if (!to) {
    return json({ ok: true, status: "skipped", reason: "RUN402_FULLSTACK_EMAIL_TO not configured" });
  }
  if (!template) {
    return json({ ok: true, status: "skipped", reason: "RUN402_FULLSTACK_EMAIL_TEMPLATE not configured" });
  }
  try {
    const result = await email.send({
      to,
      template,
      variables: { name: "Integration Test" },
      from_name: "Run402 Integration",
    });
    return json({ ok: true, status: "sent", id: result.id ?? null });
  } catch (err) {
    const transient = transientMessage(err);
    if (transient) return json({ ok: true, status: "skipped", reason: transient });
    throw err;
  }
}

function handleRoutedHttp() {
  const jsonResponse = routedHttp.json({ hello: "world" });
  const textResponse = routedHttp.text("hello text");
  const bytesResponse = routedHttp.bytes(new Uint8Array([1, 2, 3]));
  return json({
    ok: true,
    json: {
      status: jsonResponse.status,
      contentType: jsonResponse.headers?.find(([n]) => n === "content-type")?.[1],
      bodySize: jsonResponse.body?.size,
    },
    text: {
      status: textResponse.status,
      contentType: textResponse.headers?.find(([n]) => n === "content-type")?.[1],
      bodySize: textResponse.body?.size,
    },
    bytes: {
      status: bytesResponse.status,
      bodySize: bytesResponse.body?.size,
    },
  });
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
    case "ai-translate":
      return handleAiTranslate();
    case "ai-generate-image":
      return handleAiGenerateImage();
    case "admin-db-from":
      return handleAdminDbFrom();
    case "email-template":
      return handleEmailTemplate();
    case "routedhttp":
      return handleRoutedHttp();
    case "storage": {
      const result = await uploadFromFunction();
      return json({ ok: true, status: result.status, asset: result, reason: result.reason });
    }
    default:
      return json({ ok: false, error: "unknown action" }, { status: 400 });
  }
}
