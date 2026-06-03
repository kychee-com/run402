import type { APIRoute } from "astro";
import { auth, db, adminDb } from "@run402/functions";

export const prerender = false;

const BACK = { status: 303, headers: { Location: "/arena" } } as const;

export const POST: APIRoute = async ({ request }) => {
  await auth.requireUser();

  const form = await request.formData();
  const winnerId = String(form.get("winner") ?? "");
  const loserId = String(form.get("loser") ?? "");
  if (!winnerId || !loserId || winnerId === loserId) {
    return new Response("bad matchup", { status: 400 });
  }

  // Record the vote as the caller (RLS: voter_id DEFAULT current_user_id; the
  // UNIQUE(voter,winner,loser) constraint blocks double-voting). A duplicate
  // throws — swallow it and bounce back to the next matchup.
  try {
    await db(request).from("votes").insert({ winner_id: winnerId, loser_id: loserId });
  } catch {
    return new Response(null, BACK);
  }

  // Tally Elo as the PLATFORM (adminDb / BYPASSRLS): a villain's rating must move
  // even though the voter doesn't own either villain — the owner-update RLS would
  // (correctly) block a caller-context write here.
  const rows = (await adminDb().sql("select id, elo from villains where id = $1 or id = $2", [
    winnerId,
    loserId,
  ])) as Array<{ id: string; elo: number }>;
  const w = rows.find((r) => r.id === winnerId);
  const l = rows.find((r) => r.id === loserId);
  if (w && l) {
    const K = 32;
    const expWin = 1 / (1 + Math.pow(10, (Number(l.elo) - Number(w.elo)) / 400));
    const newW = Math.round(Number(w.elo) + K * (1 - expWin));
    const newL = Math.round(Number(l.elo) + K * (0 - (1 - expWin)));
    await adminDb().sql("update villains set elo = $1 where id = $2", [newW, winnerId]);
    await adminDb().sql("update villains set elo = $1 where id = $2", [newL, loserId]);
  }

  return new Response(null, BACK);
};
