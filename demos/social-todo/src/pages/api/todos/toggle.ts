import type { APIRoute } from "astro";
import { auth, db } from "@run402/functions";

export const prerender = false;

const BACK = { status: 303, headers: { Location: "/" } } as const;

export const POST: APIRoute = async ({ request }) => {
  await auth.requireUser();

  const form = await request.formData();
  const id = String(form.get("id") ?? "");
  if (!id) return new Response(null, BACK);

  // Read the current state (RLS lets any signed-in user read the shared list)...
  const rows = (await db(request).from("todos").select("done").eq("id", id)) as Array<{ done: boolean }>;
  const current = Array.isArray(rows) ? rows[0] : (rows as { done: boolean } | undefined);

  // ...then flip it. The owner-only UPDATE policy means this is a silent no-op on
  // someone else's row — the database, not the UI, enforces ownership.
  await db(request).from("todos").update({ done: !(current?.done ?? false) }).eq("id", id);

  return new Response(null, BACK);
};
