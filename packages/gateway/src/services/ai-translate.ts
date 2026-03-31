/**
 * AI Translation service — translates text via OpenRouter.
 *
 * Gateway owns the prompt template; user text is always the user message.
 * Usage is logged to internal.ai_usage for billing.
 */

import { OPENROUTER_API_KEY } from "../config.js";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";

// ISO 639-1 language codes (common subset)
const ISO_639_1 = new Set([
  "aa","ab","af","ak","am","an","ar","as","av","ay","az","ba","be","bg","bh","bi",
  "bm","bn","bo","br","bs","ca","ce","ch","co","cr","cs","cu","cv","cy","da","de",
  "dv","dz","ee","el","en","eo","es","et","eu","fa","ff","fi","fj","fo","fr","fy",
  "ga","gd","gl","gn","gu","gv","ha","he","hi","ho","hr","ht","hu","hy","hz","ia",
  "id","ie","ig","ii","ik","io","is","it","iu","ja","jv","ka","kg","ki","kj","kk",
  "kl","km","kn","ko","kr","ks","ku","kv","kw","ky","la","lb","lg","li","ln","lo",
  "lt","lu","lv","mg","mh","mi","mk","ml","mn","mr","ms","mt","my","na","nb","nd",
  "ne","ng","nl","nn","no","nr","nv","ny","oc","oj","om","or","os","pa","pi","pl",
  "ps","pt","qu","rm","rn","ro","ru","rw","sa","sc","sd","se","sg","si","sk","sl",
  "sm","sn","so","sq","sr","ss","st","su","sv","sw","ta","te","tg","th","ti","tk",
  "tl","tn","to","tr","ts","tt","tw","ty","ug","uk","ur","uz","ve","vi","vo","wa",
  "wo","xh","yi","yo","za","zh","zu",
]);

const TRANSLATE_MODEL = "google/gemini-2.0-flash-001";
const TRANSLATE_TIMEOUT_MS = 30_000;
const MAX_TEXT_LENGTH = 10_000;
const MAX_CONTEXT_LENGTH = 200;

export class TranslateError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "TranslateError";
  }
}

export interface TranslateResult {
  text: string;
  from: string;
  to: string;
}

/** Validate target/source language code. Returns error message or null. */
export function validateLanguageCode(code: string): string | null {
  if (typeof code !== "string") return "Language code must be a string";
  if (!ISO_639_1.has(code.toLowerCase())) return `Invalid ISO 639-1 language code: ${code}`;
  return null;
}

/** Validate translation input. Returns error message or null. */
export function validateTranslateInput(body: { text?: string; to?: string; from?: string; context?: string }): string | null {
  if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
    return "Text is required";
  }
  if (body.text.length > MAX_TEXT_LENGTH) {
    return `Text must be ${MAX_TEXT_LENGTH} characters or less`;
  }
  if (!body.to || typeof body.to !== "string") {
    return "Target language 'to' is required";
  }
  const toErr = validateLanguageCode(body.to);
  if (toErr) return toErr;
  if (body.from) {
    const fromErr = validateLanguageCode(body.from);
    if (fromErr) return fromErr;
  }
  if (body.context && typeof body.context === "string" && body.context.length > MAX_CONTEXT_LENGTH) {
    return `Context must be ${MAX_CONTEXT_LENGTH} characters or less`;
  }
  return null;
}

/** Build the system prompt for translation. */
function buildSystemPrompt(targetLang: string, sourceLang?: string, context?: string): string {
  let prompt = `You are a translator. Translate the user's text to ${targetLang}.`;
  if (sourceLang) {
    prompt += ` The source language is ${sourceLang}.`;
  }
  if (context) {
    prompt += ` Context: ${context}`;
  }
  prompt += ` Preserve all formatting (markdown, HTML tags, newlines). Return only the translated text with no commentary, explanation, or extra text.`;
  return prompt;
}

/** Translate text via OpenRouter. */
export async function translateText(
  text: string,
  to: string,
  opts?: { from?: string; context?: string },
): Promise<{ text: string; from: string; to: string; input_tokens: number; output_tokens: number; model: string }> {
  if (!OPENROUTER_API_KEY) {
    throw new TranslateError(503, "Translation service not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);

  try {
    const systemPrompt = buildSystemPrompt(to, opts?.from, opts?.context);

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: TRANSLATE_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
        temperature: 0.1,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error("OpenRouter translate error:", resp.status, errBody);
      throw new TranslateError(503, "Translation provider error");
    }

    const data = await resp.json() as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const translated = data.choices?.[0]?.message?.content?.trim();
    if (!translated) {
      throw new TranslateError(503, "Translation provider returned empty response");
    }

    // Detect source language from the response or default to "auto"
    const detectedFrom = opts?.from || "auto";

    return {
      text: translated,
      from: detectedFrom,
      to,
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
      model: TRANSLATE_MODEL,
    };
  } catch (err) {
    if (err instanceof TranslateError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new TranslateError(504, "Translation request timed out");
    }
    throw new TranslateError(503, "Translation provider unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

/** Log AI usage to internal.ai_usage table. */
export async function logAiUsage(
  projectId: string,
  operation: string,
  inputTokens: number,
  outputTokens: number,
  model: string,
): Promise<void> {
  try {
    await pool.query(
      sql(`INSERT INTO internal.ai_usage (project_id, operation, input_tokens, output_tokens, model) VALUES ($1, $2, $3, $4, $5)`),
      [projectId, operation, inputTokens, outputTokens, model],
    );
  } catch (err) {
    // Fire-and-forget — don't fail the request if logging fails
    console.error("Failed to log AI usage:", (err as Error).message);
  }
}

/** Get cumulative token usage for a project in the current billing period. */
export async function getUsageForPeriod(
  projectId: string,
  operation: string,
  periodStart: Date,
): Promise<number> {
  const result = await pool.query(
    sql(`SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::int AS total_tokens FROM internal.ai_usage WHERE project_id = $1 AND operation = $2 AND created_at >= $3`),
    [projectId, operation, periodStart.toISOString()],
  );
  return result.rows[0]?.total_tokens || 0;
}

/** Initialize the ai_usage table. */
export async function initAiUsageTable(): Promise<void> {
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.ai_usage (
      id BIGSERIAL PRIMARY KEY,
      project_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));
  await pool.query(sql(`CREATE INDEX IF NOT EXISTS idx_ai_usage_project_op ON internal.ai_usage(project_id, operation, created_at)`));
}

/** Initialize the ai_addons table. */
export async function initAiAddonsTable(): Promise<void> {
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.ai_addons (
      id BIGSERIAL PRIMARY KEY,
      project_id TEXT NOT NULL,
      addon_type TEXT NOT NULL,
      included_tokens INTEGER NOT NULL DEFAULT 0,
      billing_cycle_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(project_id, addon_type)
    )
  `));
}

/** Check if a project has an active translation add-on. Returns the add-on or null. */
export async function getTranslationAddon(projectId: string): Promise<{ included_tokens: number; billing_cycle_start: Date } | null> {
  const result = await pool.query(
    sql(`SELECT included_tokens, billing_cycle_start FROM internal.ai_addons WHERE project_id = $1 AND addon_type = 'translation' AND status = 'active'`),
    [projectId],
  );
  if (result.rows.length === 0) return null;
  return {
    included_tokens: result.rows[0].included_tokens,
    billing_cycle_start: new Date(result.rows[0].billing_cycle_start),
  };
}

/** Convert tokens to words for display. */
export function tokensToWords(tokens: number): number {
  return Math.round(tokens / 1.3);
}

/** Convert words to tokens for quota. */
export function wordsToTokens(words: number): number {
  return Math.round(words * 1.3);
}
