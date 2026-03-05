/**
 * EvilMe — Villain Origin Story Generator
 *
 * Routes:
 *   POST /generate  — create a villain (name, fact, appearance)
 *   GET  /gallery   — public gallery (top villains by Elo)
 *   GET  /villain/:id — single villain
 *   GET  /matchup   — random pair for voting
 *   POST /vote      — submit vote (winner_id, loser_id)
 *   GET  /leaderboard — top 20 by Elo
 */

import { db } from "@run402/functions";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Style suffix — kept minimal so character details dominate
const MANGA_STYLE_SUFFIX = `Manga art style with bold ink lines. Dramatic lighting. Half-body portrait. No text in image.`;

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1\/evilme/, "");
  const method = req.method;

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  try {
    if (method === "POST" && path === "/generate") {
      return await handleGenerate(req);
    }
    if (method === "GET" && path === "/gallery") {
      return await handleGallery(url);
    }
    if (method === "GET" && path.startsWith("/villain/")) {
      const id = path.replace("/villain/", "");
      return await handleGetVillain(id);
    }
    if (method === "GET" && path === "/matchup") {
      return await handleMatchup();
    }
    if (method === "POST" && path === "/vote") {
      return await handleVote(req);
    }
    if (method === "GET" && path === "/leaderboard") {
      return await handleLeaderboard();
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error("Handler error:", err.message || err);
    return json({ error: "Something went wrong" }, 500);
  }
};

// === Handlers ===

async function handleGenerate(req) {
  const body = await req.json();
  const { name, fact, appearance } = body;

  if (!name || !fact) {
    return json({ error: "Name and fact are required" }, 400);
  }

  // Rate limit: 3 per day per IP (stored in DB)
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rateCheck = await db.sql(
    `SELECT count(*)::int AS cnt FROM villains
     WHERE creator_ip = '${ip.replace(/'/g, "''")}'
     AND created_at > now() - interval '24 hours'`
  );
  if (rateCheck.rows?.[0]?.cnt >= 3) {
    return json({ error: "Rate limit: 3 villains per day. Come back tomorrow!" }, 429);
  }

  // Generate villain story with GPT
  const storyPrompt = `You are a campy, over-the-top villain origin story narrator. Think comic book meets comedy.

The user's name is "${name}".
Their mundane fact: "${fact}"
${appearance ? `Their appearance: "${appearance}"` : ""}

Generate a JSON object with these fields:
- villain_name: A dramatic, ridiculous supervillain name inspired by their mundane fact
- origin_story: A 3-4 sentence dramatic but funny origin story. Make it absurdly theatrical. Reference their real fact.
- evil_catchphrase: Their signature villain catchphrase (short, memorable, funny)
- weakness: Their one ridiculous weakness that relates to their mundane fact
- evil_power: Their main superpower (absurd, related to their fact)
- threat_level: A funny threat rating like "Moderate (to salad bars)" or "Critical (on Tuesdays)"

Return ONLY valid JSON, no markdown.`;

  const storyResponse = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages: [{ role: "user", content: storyPrompt }],
    temperature: 1.0,
  });

  let villain;
  try {
    const raw = storyResponse.choices[0].message.content.trim();
    villain = JSON.parse(raw.replace(/```json\n?/g, "").replace(/```/g, ""));
  } catch {
    return json({ error: "Failed to generate villain story" }, 500);
  }

  // Generate manga portrait — character details FIRST so they dominate the image
  const imagePrompt = `Portrait of ${appearance ? appearance : "a mysterious person"}, reimagined as the supervillain "${villain.villain_name}".

Their superpower: ${villain.evil_power}. Show this power visually — it should be obvious from the portrait what their ability is. Give them a unique costume or accessories that reflect their theme.

Their personality: theatrical, campy, ${villain.threat_level}. Expression: confident smirk or dramatic pose.

${MANGA_STYLE_SUFFIX}`;

  let imageUrl = "";
  try {
    const imageResponse = await openai.images.generate({
      model: "gpt-image-1",
      prompt: imagePrompt,
      n: 1,
      size: "1024x1024",
      quality: "low",
    });
    // gpt-image-1 returns base64
    if (imageResponse.data[0].b64_json) {
      imageUrl = `data:image/png;base64,${imageResponse.data[0].b64_json}`;
    } else {
      imageUrl = imageResponse.data[0].url;
    }
  } catch (imgErr) {
    console.error("Image generation failed:", imgErr.message);
    // Fallback to DALL-E 3
    try {
      const fallback = await openai.images.generate({
        model: "dall-e-3",
        prompt: imagePrompt,
        n: 1,
        size: "1024x1024",
        quality: "hd",
      });
      imageUrl = fallback.data[0].url;
    } catch (fallbackErr) {
      console.error("DALL-E fallback also failed:", fallbackErr.message);
      imageUrl = "";
    }
  }

  // Store in DB
  const insertResult = await db.sql(
    `INSERT INTO villains (name, real_name, fact, appearance, villain_name, origin_story, evil_catchphrase, weakness, evil_power, threat_level, image_url, creator_ip, elo_rating)
     VALUES ('${esc(name)}', '${esc(name)}', '${esc(fact)}', '${esc(appearance || "")}', '${esc(villain.villain_name)}', '${esc(villain.origin_story)}', '${esc(villain.evil_catchphrase)}', '${esc(villain.weakness)}', '${esc(villain.evil_power)}', '${esc(villain.threat_level)}', '${esc(imageUrl)}', '${esc(ip)}', 1200)
     RETURNING id, villain_name, origin_story, evil_catchphrase, weakness, evil_power, threat_level, image_url, created_at`
  );

  const row = insertResult.rows[0];
  return json({
    id: row.id,
    villain_name: row.villain_name,
    origin_story: row.origin_story,
    evil_catchphrase: row.evil_catchphrase,
    weakness: row.weakness,
    evil_power: row.evil_power,
    threat_level: row.threat_level,
    image_url: row.image_url,
    share_url: `https://evilme.run402.com/#/villain/${row.id}`,
  });
}

async function handleGallery(url) {
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = 12;
  const offset = (page - 1) * limit;

  const result = await db.sql(
    `SELECT id, villain_name, origin_story, evil_catchphrase, weakness, evil_power, threat_level, image_url, elo_rating, created_at
     FROM villains ORDER BY elo_rating DESC, created_at DESC LIMIT ${limit} OFFSET ${offset}`
  );

  const countResult = await db.sql(`SELECT count(*)::int AS total FROM villains`);

  return json({
    villains: result.rows,
    total: countResult.rows[0]?.total || 0,
    page,
    pages: Math.ceil((countResult.rows[0]?.total || 0) / limit),
  });
}

async function handleGetVillain(id) {
  const result = await db.sql(
    `SELECT id, villain_name, real_name, origin_story, evil_catchphrase, weakness, evil_power, threat_level, image_url, elo_rating, created_at
     FROM villains WHERE id = ${parseInt(id)}`
  );
  if (!result.rows?.length) {
    return json({ error: "Villain not found" }, 404);
  }
  return json(result.rows[0]);
}

async function handleMatchup() {
  // Get 2 random villains with images
  const result = await db.sql(
    `SELECT id, villain_name, evil_power, threat_level, image_url, elo_rating
     FROM villains WHERE image_url != ''
     ORDER BY random() LIMIT 2`
  );
  if (result.rows?.length < 2) {
    return json({ error: "Not enough villains for a matchup yet" }, 404);
  }
  return json({ villain_a: result.rows[0], villain_b: result.rows[1] });
}

async function handleVote(req) {
  const { winner_id, loser_id } = await req.json();
  if (!winner_id || !loser_id) {
    return json({ error: "winner_id and loser_id required" }, 400);
  }

  // Fetch current Elo ratings
  const ratings = await db.sql(
    `SELECT id, elo_rating FROM villains WHERE id IN (${parseInt(winner_id)}, ${parseInt(loser_id)})`
  );
  if (ratings.rows?.length < 2) {
    return json({ error: "Villain not found" }, 404);
  }

  const winner = ratings.rows.find(r => r.id === parseInt(winner_id));
  const loser = ratings.rows.find(r => r.id === parseInt(loser_id));

  // Elo calculation (K=32)
  const K = 32;
  const expectedWinner = 1 / (1 + Math.pow(10, (loser.elo_rating - winner.elo_rating) / 400));
  const expectedLoser = 1 - expectedWinner;

  const newWinnerElo = Math.round(winner.elo_rating + K * (1 - expectedWinner));
  const newLoserElo = Math.round(loser.elo_rating + K * (0 - expectedLoser));

  await db.sql(`UPDATE villains SET elo_rating = ${newWinnerElo} WHERE id = ${winner.id}`);
  await db.sql(`UPDATE villains SET elo_rating = ${newLoserElo} WHERE id = ${loser.id}`);

  return json({
    winner: { id: winner.id, new_elo: newWinnerElo },
    loser: { id: loser.id, new_elo: newLoserElo },
  });
}

async function handleLeaderboard() {
  const result = await db.sql(
    `SELECT id, villain_name, evil_power, threat_level, image_url, elo_rating
     FROM villains ORDER BY elo_rating DESC LIMIT 20`
  );
  return json({ leaderboard: result.rows });
}

// === Helpers ===

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, apikey, Authorization",
  };
}

function esc(s) {
  return (s || "").replace(/'/g, "''");
}
