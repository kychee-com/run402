import { adminDb, auth } from "@run402/functions";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function text(value, field, max) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new Response(JSON.stringify({ error: `${field} must contain 1-${max} characters` }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }
  return value.trim();
}

function id(value, field) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Response(JSON.stringify({ error: `${field} must be a UUID` }), { status: 400, headers: JSON_HEADERS });
  }
  return value;
}

async function readBoard() {
  const result = await adminDb().sql(`
    SELECT i.id, i.title, i.body, i.attachment_url, i.status, i.created_at,
           COUNT(DISTINCT v.user_id)::INTEGER AS votes,
           COALESCE(
             jsonb_agg(
               DISTINCT jsonb_build_object('id', c.id, 'body', c.body, 'created_at', c.created_at)
             ) FILTER (WHERE c.id IS NOT NULL),
             '[]'::jsonb
           ) AS comments
      FROM feedback_items i
      LEFT JOIN feedback_votes v ON v.feedback_id = i.id
      LEFT JOIN feedback_comments c ON c.feedback_id = i.id
     GROUP BY i.id
     ORDER BY i.created_at DESC
     LIMIT 100
  `);
  return result.rows;
}

export default async function feedback(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method === "GET") return json({ items: await readBoard() });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const user = await auth.user();
    if (!user) return json({ error: "auth_required" }, 401);
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid_json" }, 400);

    if (body.action === "create") {
      const title = text(body.title, "title", 120);
      if (title.length < 3) return json({ error: "title must contain 3-120 characters" }, 400);
      const description = text(body.body, "body", 2000);
      const attachment = body.attachment_url == null ? null : new URL(text(body.attachment_url, "attachment_url", 2048));
      if (attachment && attachment.protocol !== "https:") return json({ error: "attachment_url must use https" }, 400);
      const result = await adminDb().sql(
        "INSERT INTO feedback_items (author_id, title, body, attachment_url) VALUES ($1,$2,$3,$4) RETURNING id",
        [user.id, title, description, attachment?.href ?? null],
      );
      return json({ created: true, id: result.rows[0]?.id }, 201);
    }

    if (body.action === "vote") {
      const feedbackId = id(body.feedback_id, "feedback_id");
      await adminDb().sql(
        "INSERT INTO feedback_votes (feedback_id, user_id) VALUES ($1,$2) ON CONFLICT (feedback_id, user_id) DO NOTHING",
        [feedbackId, user.id],
      );
      return json({ voted: true });
    }

    if (body.action === "comment") {
      const feedbackId = id(body.feedback_id, "feedback_id");
      const comment = text(body.body, "body", 1000);
      const result = await adminDb().sql(
        "INSERT INTO feedback_comments (feedback_id, author_id, body) VALUES ($1,$2,$3) RETURNING id",
        [feedbackId, user.id, comment],
      );
      return json({ created: true, id: result.rows[0]?.id }, 201);
    }

    return json({ error: "unknown_action" }, 400);
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
