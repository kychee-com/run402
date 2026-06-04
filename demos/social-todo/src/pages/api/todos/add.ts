import type { APIRoute } from "astro";
import { auth, db } from "@run402/functions";

export const prerender = false;

const BACK = { status: 303, headers: { Location: "/" } } as const;

export const POST: APIRoute = async ({ request }) => {
  // 303 → /auth/sign-in (HTML) / 401 (JSON) on anonymous. Never catch it.
  await auth.requireUser();

  const form = await request.formData();
  const text = String(form.get("text") ?? "").trim().slice(0, 200);
  if (!text) return new Response(null, BACK);

  // user_id is supplied by the column DEFAULT run402.current_user_id() and bound
  // by the RLS WITH CHECK — so we never pass it (and never add a redundant
  // `.eq("user_id", …)`, which deploy-fails R402_AUTH_REDUNDANT_USER_FILTER).
  await db(request).from("todos").insert({ text });

  return new Response(null, BACK);
};
