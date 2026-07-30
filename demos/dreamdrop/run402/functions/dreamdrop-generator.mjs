import {
  adminDb,
  ai,
  assets,
  email,
  getRoutedPaymentContext,
  getRun402Context,
} from "@run402/functions";

const VIBES = new Set(["kinetic", "cosmic", "organic", "quiet"]);
const ART_KEYS = ["reef", "orb", "moss", "luna", "signal", "drift"];
const PALETTES = {
  kinetic: ["#ff6b57", "#d8ff5e", "#b9a7ff"],
  cosmic: ["#b9a7ff", "#5de4ff", "#ff8ab7"],
  organic: ["#d8ff5e", "#68c38c", "#ff9b6a"],
  quiet: ["#f4efdf", "#b9a7ff", "#7e8b82"],
};

export default async function dreamdropGenerator(req) {
  const pathname = safePathname(req.url);
  let generationReservationId = null;
  try {
    if (req.method === "GET") return await listDreamDrops(req);
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET, POST" } });
    }

    const body = await readBody(req);
    if (body.mode === "email" || pathname.endsWith("/email")) return await sendDreamDropEmail(body);

    const payment = getRoutedPaymentContext(req);
    const isPublicHumanRoute = pathname.startsWith("/api/dreamdrops/");

    const parent = body.mode === "remix" || pathname.endsWith("/remix")
      ? await findParent(body.parentId)
      : null;
    const idea = cleanIdea(parent
      ? `${parent.prompt} Reimagine it for a world where screens disappeared overnight.`
      : body.idea);
    const vibe = VIBES.has(body.vibe) ? body.vibe : parent?.vibe ?? "kinetic";

    const moderation = await ai.moderate(idea);
    if (moderation.flagged) return Response.json({ error: "That idea cannot be rendered." }, { status: 422 });
    if (isPublicHumanRoute && !payment) generationReservationId = await reservePublicGeneration(req);

    const id = crypto.randomUUID();
    const title = titleFromIdea(idea);
    const hook = hookFor(vibe);
    const image = await ai.generateImage({
      aspect: "portrait",
      prompt: `Editorial launch poster for an imaginary product called "${title}". ${idea} ${hook} Sophisticated art direction, tactile materials, surreal product photography, bold composition, near-black shadows with ${PALETTES[vibe].join(", ")} accents. No words, letters, logos, UI, frame, or watermark.`,
    });
    const bytes = Uint8Array.from(Buffer.from(image.image, "base64"));
    const extension = extensionFor(image.content_type);
    const asset = await assets.put(`dreamdrops/${id}.${extension}`, { bytes }, {
      contentType: image.content_type,
      visibility: "public",
      immutable: true,
      exifPolicy: "strip",
      metadata: { app: "dreamdrop", vibe, generated: true },
    });

    const now = new Date().toISOString();
    const row = {
      id,
      parent_id: parent?.id ?? null,
      title,
      prompt: idea,
      hook,
      vibe,
      image_url: asset.display_immutable_url ?? asset.cdn_immutable_url ?? asset.immutable_url ?? asset.url,
      art_key: ART_KEYS[id.charCodeAt(0) % ART_KEYS.length],
      palette: PALETTES[vibe],
      remix_count: 0,
      creator: payment?.payer ? `Agent ${payment.payer.slice(0, 6)}` : isPublicHumanRoute ? "Guest" : "You",
      payment_id: payment?.paymentId ?? null,
      payment_payer: payment?.payer ?? null,
      payment_amount_usd_micros: payment?.amountUsdMicros ?? null,
      created_at: now,
    };

    await adminDb().from("dreamdrops").insert(row);
    if (parent) {
      await adminDb().sql("UPDATE dreamdrops SET remix_count = remix_count + 1 WHERE id = $1", [parent.id]);
    }
    return Response.json({
      ok: true,
      drop: row,
      artifact: rowToDrop(row),
      infrastructure: ["moderation", "image-generation", "assets", "postgres", payment ? "x402" : "public-demo-cap"],
    }, { status: 201 });
  } catch (error) {
    console.error("dreamdrop_generator_failed", error);
    const message = error instanceof Error ? error.message : String(error);
    const needsEmailCredits = /email.*credits?|credits?.*email/i.test(message);
    const needsImageCredits = /PAYMENT_REQUIRED|insufficient balance/i.test(message);
    const needsCredits = needsEmailCredits || needsImageCredits;
    const status = needsCredits ? 503 : [400, 404, 429].includes(error?.status) ? error.status : 500;
    const publicMessage = needsCredits
      ? needsEmailCredits
        ? "DreamDrop email needs Run402 email credits. Try again after credits land."
        : "DreamDrop's image forge needs a Run402 balance top-up. Try again after credits land."
      : status === 500 ? "Artifact generation failed." : message;
    if (generationReservationId && status >= 500) await releasePublicGeneration(generationReservationId);
    return Response.json({ error: publicMessage }, { status });
  }
}

async function listDreamDrops(req) {
  const rows = rowsFromSql(await adminDb().sql(
    "SELECT * FROM dreamdrops ORDER BY created_at DESC LIMIT 24",
  ));
  const context = getRun402Context(req);
  const origin = context.host ? `https://${context.host}` : new URL(req.url).origin;
  return Response.json({
    drops: rows.map(rowToDrop),
    mode: "run402",
    statusLabel: "RUN402 CLOUD LIVE",
    agentEndpoint: `${origin}/agent/remix`,
    capabilities: ["Postgres", "Serverless", "AI image", "CDN assets", "x402", "Email"],
  });
}

async function sendDreamDropEmail(body) {
  const address = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw httpError(400, "Enter a valid email address.");
  const drop = await findParent(body.id);
  const reservationId = await reservePublicEmail(address);
  let result;
  try {
    result = await email.send({
      to: address,
      from_name: "DreamDrop",
      subject: `${drop.title} just dropped`,
      html: renderEmail(drop),
      text: `${drop.title}\n\n${drop.hook}\n\n${drop.prompt}\n\nMade with Wasp × Run402.`,
    });
  } catch (error) {
    await releasePublicEmail(reservationId);
    throw error;
  }
  return Response.json({ status: "sent", message: `Sent via Run402 · ${result.id ?? result.message_id ?? "accepted"}` });
}

async function reservePublicGeneration(req) {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const actorHash = await sha256(forwarded || req.headers.get("user-agent") || "anonymous");
  const inserted = rowsFromSql(await adminDb().sql(
    `WITH counts AS (
       SELECT count(*)::int AS global_count,
              count(*) FILTER (WHERE actor_hash = $1)::int AS actor_count
       FROM dreamdrop_generation_events
       WHERE created_at >= now() - interval '24 hours'
     )
     INSERT INTO dreamdrop_generation_events (actor_hash)
     SELECT $1 FROM counts WHERE global_count < 24 AND actor_count < 3
     RETURNING id`,
    [actorHash],
  ));
  if (!inserted[0]) throw httpError(429, "The public forge has reached its daily demo limit. The paid agent route is still available.");
  return inserted[0].id;
}

async function reservePublicEmail(address) {
  const recipientHash = await sha256(address);
  const inserted = rowsFromSql(await adminDb().sql(
    `WITH counts AS (
       SELECT count(*)::int AS global_count,
              count(*) FILTER (WHERE recipient_hash = $1)::int AS recipient_count
       FROM dreamdrop_email_events
       WHERE created_at >= now() - interval '24 hours'
     )
     INSERT INTO dreamdrop_email_events (recipient_hash)
     SELECT $1 FROM counts WHERE global_count < 30 AND recipient_count < 1
     RETURNING id`,
    [recipientHash],
  ));
  if (!inserted[0]) throw httpError(429, "That address already received a DreamDrop today.");
  return inserted[0].id;
}

async function releasePublicGeneration(id) {
  try {
    await adminDb().sql("DELETE FROM dreamdrop_generation_events WHERE id = $1", [id]);
  } catch (error) {
    console.error("dreamdrop_generation_reservation_release_failed", error);
  }
}

async function releasePublicEmail(id) {
  try {
    await adminDb().sql("DELETE FROM dreamdrop_email_events WHERE id = $1", [id]);
  } catch (error) {
    console.error("dreamdrop_email_reservation_release_failed", error);
  }
}

async function readBody(req) {
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    throw httpError(400, "Send a JSON body.");
  }
}

async function findParent(id) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw httpError(400, "A valid DreamDrop id is required.");
  }
  const rows = rowsFromSql(await adminDb().sql("SELECT * FROM dreamdrops WHERE id = $1 LIMIT 1", [id]));
  if (!rows[0]) throw httpError(404, "DreamDrop not found.");
  return rows[0];
}

function cleanIdea(value) {
  const idea = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (idea.length < 12 || idea.length > 280) throw httpError(400, "idea must be 12–280 characters.");
  return idea;
}

function titleFromIdea(idea) {
  const words = idea.replace(/[^a-zA-Z0-9\s-]/g, " ").trim().split(/\s+/)
    .filter((word) => !["a", "an", "the", "that", "for", "with"].includes(word.toLowerCase())).slice(0, 3);
  return (words.length ? words : ["Untitled", "Future"])
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

function hookFor(vibe) {
  return {
    kinetic: "Too strange to ignore. Too useful to forget.",
    cosmic: "A small portal for a much bigger possibility.",
    organic: "Technology that behaves more like a living thing.",
    quiet: "Less interface. More feeling.",
  }[vibe];
}

function rowToDrop(row) {
  const palette = Array.isArray(row.palette) ? row.palette : PALETTES.kinetic;
  return {
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    prompt: row.prompt,
    hook: row.hook,
    vibe: row.vibe,
    imageUrl: row.image_url,
    artKey: row.art_key,
    palette: [palette[0], palette[1], palette[2]],
    remixCount: Number(row.remix_count),
    createdAt: new Date(row.created_at).toISOString(),
    createdLabel: relativeLabel(row.created_at),
    creator: row.creator,
    source: "run402",
    payment: row.payment_id ? {
      paymentId: row.payment_id,
      payer: row.payment_payer,
      amountUsdMicros: Number(row.payment_amount_usd_micros ?? 0),
    } : null,
  };
}

function relativeLabel(value) {
  const ageMinutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (ageMinutes < 1) return "JUST NOW";
  if (ageMinutes < 60) return `${ageMinutes} MIN AGO`;
  if (ageMinutes < 1_440) return `${Math.floor(ageMinutes / 60)} HRS AGO`;
  return `${Math.floor(ageMinutes / 1_440)} DAYS AGO`;
}

function renderEmail(drop) {
  const image = drop.image_url
    ? `<img src="${escapeHtml(drop.image_url)}" alt="" style="width:100%;border-radius:18px;display:block" />`
    : "";
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:auto;background:#11110f;color:#f4efdf;padding:32px;border-radius:24px">${image}<p style="color:#d8ff5e;text-transform:uppercase;letter-spacing:.12em">DreamDrop</p><h1>${escapeHtml(drop.title)}</h1><p style="font-size:20px">${escapeHtml(drop.hook)}</p><p style="color:#b8b6aa">${escapeHtml(drop.prompt)}</p><p style="margin-top:32px;color:#77766f">Made with Wasp × Run402</p></div>`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function extensionFor(contentType) {
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/jpeg") return "jpg";
  return "png";
}

function rowsFromSql(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  return [];
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safePathname(value) {
  try { return new URL(value).pathname; }
  catch { return "/"; }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
