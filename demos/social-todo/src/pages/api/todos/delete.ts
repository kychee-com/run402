import type { APIRoute } from "astro";
import { auth, db } from "@run402/functions";

export const prerender = false;

const BACK = { status: 303, headers: { Location: "/" } } as const;

export const POST: APIRoute = async ({ request }) => {
  await auth.requireUser();

  const form = await request.formData();
  const id = String(form.get("id") ?? "");
  // The owner-only DELETE policy makes this a no-op on rows you don't own.
  if (id) await db(request).from("todos").delete().eq("id", id);

  return new Response(null, BACK);
};
