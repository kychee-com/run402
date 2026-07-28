import { adminDb, auth } from "@run402/functions";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export default async function feedbackAdmin(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    await auth.requireRole("admin");
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid_json" }, 400);
    if (body.action !== "set_status") return json({ error: "unknown_action" }, 400);
    if (typeof body.feedback_id !== "string" || !UUID.test(body.feedback_id)) {
      return json({ error: "feedback_id must be a UUID" }, 400);
    }
    if (!["open", "planned", "shipped", "closed"].includes(body.status)) {
      return json({ error: "invalid status" }, 400);
    }
    await adminDb().sql("UPDATE feedback_items SET status = $2 WHERE id = $1", [body.feedback_id, body.status]);
    return json({ updated: true });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
