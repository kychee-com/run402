import type { APIRoute } from "astro";
import { auth, db, ai, assets } from "@run402/functions";
import { makeVillain, portraitPrompt } from "../../lib/story";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  // Gate: requireUser 303s to /auth/sign-in (HTML) or returns a 401 envelope
  // (JSON) on anonymous callers. Never catch it — the platform decides which.
  await auth.requireUser();

  const form = await request.formData();
  const realName = String(form.get("name") ?? "").trim().slice(0, 60);
  const fact = String(form.get("fact") ?? "").trim().slice(0, 200);
  const appearance = String(form.get("appearance") ?? "").trim().slice(0, 200);
  if (!realName || !fact) {
    return new Response("Your name and one mundane fact are required.", { status: 400 });
  }

  const villain = makeVillain({ realName, fact, appearance });

  // Owner-gated insert through db(req). user_id is supplied by the column
  // DEFAULT run402.current_user_id(), so we never pass it (and must never add a
  // redundant `.eq("user_id", …)` — that deploy-fails R402_AUTH_REDUNDANT_USER_FILTER).
  // Surface the real cause instead of a swallowed generic 500 (the SSR runtime
  // also stamps x-run402-request-id, so a thrown error is traceable via
  // `run402 logs --request-id <id>`).
  let row: { id?: string } | undefined;
  try {
    const inserted = await db(request).from("villains").insert({
      real_name: realName,
      fact,
      appearance,
      villain_name: villain.villainName,
      origin_story: villain.originStory,
      catchphrase: villain.catchphrase,
      weakness: villain.weakness,
      power: villain.power,
      threat_level: villain.threatLevel,
    });
    row = (Array.isArray(inserted) ? inserted[0] : inserted) as { id?: string } | undefined;
  } catch (err) {
    console.error("villain insert failed:", err);
    return new Response("Could not save your villain — the database insert failed.", { status: 500 });
  }
  if (!row?.id) {
    return new Response("Villain insert returned no id (is the villains table migrated?).", { status: 500 });
  }

  // Generate the portrait ON run402 (ai.generateImage → base64) and store the
  // bytes in the project's CAS blob store (assets.put → AssetRef). Persist the
  // FULL AssetRef as JSONB so <Run402Picture asset={...}> renders straight from
  // the row. A portrait failure must not lose the villain — best-effort.
  try {
    const img = await ai.generateImage({ prompt: portraitPrompt(villain, appearance), aspect: "portrait" });
    const bytes = Buffer.from(img.image, "base64");
    const ref = await assets.put(`villains/${row.id}.png`, bytes, { contentType: img.content_type });
    await db(request).from("villains").update({ portrait: ref }).eq("id", row.id);
  } catch (err) {
    console.error("portrait generation failed (villain still created):", err);
  }

  return new Response(null, { status: 303, headers: { Location: `/villain/${row.id}` } });
};
