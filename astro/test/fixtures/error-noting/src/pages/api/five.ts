import type { APIRoute } from "astro";
export const GET: APIRoute = async () => new Response("nope", { status: 503 });
