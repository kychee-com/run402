/**
 * Cosmic Forge — Concept Embedding Function
 *
 * Routes:
 *   POST /embed  — takes { concept }, returns embedding + AI-generated name & description
 */

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1\/cosmicforge/, "");
  const method = req.method;

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    if (method === "POST" && path === "/embed") {
      return await handleEmbed(req);
    }
    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error("Handler error:", err.message || err);
    return json({ error: "Something went wrong" }, 500);
  }
};

async function handleEmbed(req) {
  const body = await req.json();
  const { concept } = body;

  if (!concept || typeof concept !== "string" || concept.trim().length === 0) {
    return json({ error: "concept is required" }, 400);
  }

  const trimmed = concept.trim().substring(0, 100);

  // Run embedding and name generation in parallel
  const [embeddingResult, nameResult] = await Promise.all([
    openai.embeddings.create({
      model: "text-embedding-3-small",
      input: trimmed,
    }),
    openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{
        role: "user",
        content: `You are a cosmic narrator. The user typed the concept: "${trimmed}".

Give it a poetic cosmic entity name (2-4 words, dramatic) and a one-sentence description (max 20 words) that connects the concept to a cosmic/particle visualization.

Return ONLY valid JSON: {"name": "...", "desc": "..."}`,
      }],
      temperature: 1.0,
    }),
  ]);

  const embedding = embeddingResult.data[0].embedding;

  let name = trimmed;
  let desc = "";
  try {
    const raw = nameResult.choices[0].message.content.trim();
    const parsed = JSON.parse(raw.replace(/```json\n?/g, "").replace(/```/g, ""));
    name = parsed.name || trimmed;
    desc = parsed.desc || "";
  } catch {
    // Fall back to concept as name
  }

  // Send a compact subset of the embedding — 64 dims is enough to drive the visuals
  // and keeps the response small (~1KB vs ~20KB for full 1536)
  const compact = [];
  const step = Math.floor(embedding.length / 64);
  for (let i = 0; i < 64; i++) {
    compact.push(Math.round(embedding[i * step] * 10000) / 10000);
  }

  return json({ name, desc, embedding: compact });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, apikey, Authorization",
  };
}
