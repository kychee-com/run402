/**
 * EvilMe — Villain Origin Story Generator
 *
 * Routes:
 *   POST /generate  — create a villain (name, fact, appearance)
 *   GET  /gallery   — public gallery (top villains by Elo)
 *   GET  /villain/:id — single villain
 *   GET  /villain/:id/image — just the image_url for one villain
 *   GET  /matchup   — random pair for voting
 *   POST /vote      — submit vote (winner_id, loser_id)
 *   GET  /leaderboard — top 20 by Elo
 */

import { db } from "@run402/functions";
import OpenAI from "openai";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const s3 = new S3Client({ region: "us-east-1" });
const BASE_URL = process.env.BASE_URL || "https://api.run402.com";
const S3_BUCKET = "agentdb-storage-472210437512";
const IMAGE_CDN = "https://evilme-images.sites.run402.com";

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
    if (method === "GET" && path.match(/^\/villain\/\d+\/image$/)) {
      const id = path.split("/")[2];
      return await handleVillainImage(id);
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
  // Auth: require Bearer token with "authenticated" role
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return json({ error: "Login required to generate a villain" }, 401);
  }

  let jwtPayload;
  try {
    const token = authHeader.split(" ")[1];
    jwtPayload = JSON.parse(atob(token.split(".")[1]));
  } catch {
    return json({ error: "Login required to generate a villain" }, 401);
  }

  if (jwtPayload.role !== "authenticated") {
    return json({ error: "Login required to generate a villain" }, 401);
  }

  const userId = jwtPayload.sub;

  const body = await req.json();
  const { name, fact, appearance } = body;

  if (!name || !fact) {
    return json({ error: "Name and fact are required" }, 400);
  }

  // Rate limit: 3 per day per user
  const rateCheck = await db.sql(
    `SELECT count(*)::int AS cnt FROM villains
     WHERE creator_ip = '${esc(userId)}'
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

  // Insert villain into DB first (without image) to get an ID for S3 key
  const insertResult = await db.sql(
    `INSERT INTO villains (name, real_name, fact, appearance, villain_name, origin_story, evil_catchphrase, weakness, evil_power, threat_level, image_url, creator_ip, elo_rating)
     VALUES ('${esc(name)}', '${esc(name)}', '${esc(fact)}', '${esc(appearance || "")}', '${esc(villain.villain_name)}', '${esc(villain.origin_story)}', '${esc(villain.evil_catchphrase)}', '${esc(villain.weakness)}', '${esc(villain.evil_power)}', '${esc(villain.threat_level)}', '', '${esc(userId)}', 1200)
     RETURNING id, villain_name, origin_story, evil_catchphrase, weakness, evil_power, threat_level, created_at`
  );

  const row = insertResult.rows[0];
  let publicImageUrl = "";
  let shareUrl = `https://evilme.run402.com/#/villain/${row.id}`;

  // Generate image via Run402's own /v1/generate-image (admin key bypasses x402)
  try {
    const imageResp = await fetch(`${BASE_URL}/v1/generate-image`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Key": process.env.ADMIN_KEY,
      },
      body: JSON.stringify({ prompt: imagePrompt, aspect: "square" }),
    });

    if (!imageResp.ok) {
      console.error("Image API error:", imageResp.status);
    } else {
      const imageData = await imageResp.json();
      if (imageData.image) {
        // Upload directly to S3 (avoid putting large base64 in DB)
        await s3.send(new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: `sites/evilme_images/${row.id}.png`,
          Body: Buffer.from(imageData.image, "base64"),
          ContentType: "image/png",
        }));
        publicImageUrl = `${IMAGE_CDN}/${row.id}.png`;

        // Upload OG card for social sharing
        await s3.send(new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: `sites/evilme_images/card/${row.id}.html`,
          Body: buildCardHtml(row, publicImageUrl),
          ContentType: "text/html",
        }));
        shareUrl = `${IMAGE_CDN}/card/${row.id}.html`;

        // Update DB with CDN URL
        await db.sql(`UPDATE villains SET image_url = '${esc(publicImageUrl)}' WHERE id = ${row.id}`);
      }
    }
  } catch (imgErr) {
    console.error("Image generation failed:", imgErr.message);
  }

  return json({
    id: row.id,
    villain_name: row.villain_name,
    origin_story: row.origin_story,
    evil_catchphrase: row.evil_catchphrase,
    weakness: row.weakness,
    evil_power: row.evil_power,
    threat_level: row.threat_level,
    image_url: publicImageUrl,
    share_url: shareUrl,
  });
}

async function handleGallery(url) {
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = 12;
  const offset = (page - 1) * limit;

  const result = await db.sql(
    `SELECT id, villain_name, origin_story, evil_catchphrase, weakness, evil_power, threat_level, elo_rating, created_at
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

async function handleVillainImage(id) {
  const result = await db.sql(
    `SELECT image_url FROM villains WHERE id = ${parseInt(id)}`
  );
  if (!result.rows?.length) {
    return json({ error: "Villain not found" }, 404);
  }
  return json({ image_url: result.rows[0].image_url });
}

async function handleMatchup() {
  // Get 2 random villains with images
  const result = await db.sql(
    `SELECT id, villain_name, evil_power, threat_level, elo_rating
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
    `SELECT id, villain_name, evil_power, threat_level, elo_rating
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

function escHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildCardHtml(villain, imageUrl) {
  const name = escHtml(villain.villain_name);
  const catchphrase = escHtml(villain.evil_catchphrase);
  const story = escHtml(villain.origin_story);
  const spaUrl = `https://evilme.run402.com/#/villain/${villain.id}`;
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>${name} — EvilMe</title>
<meta property="og:title" content="${name}">
<meta property="og:description" content="&quot;${catchphrase}&quot;">
<meta property="og:image" content="${imageUrl}">
<meta property="og:url" content="${spaUrl}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${name} — EvilMe">
<meta name="twitter:description" content="&quot;${catchphrase}&quot;">
<meta name="twitter:image" content="${imageUrl}">
<meta http-equiv="refresh" content="0;url=${spaUrl}">
</head>
<body><p>Redirecting to <a href="${spaUrl}">${name}</a>...</p></body>
</html>`;
}
