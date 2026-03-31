/**
 * AI Moderation service — proxies to OpenAI Moderation API (free).
 *
 * Returns category flags and scores. No token cost, no billing.
 */

import { OPENAI_API_KEY } from "../config.js";

const MODERATE_TIMEOUT_MS = 10_000;
const MAX_TEXT_LENGTH = 10_000;

export class ModerateError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ModerateError";
  }
}

export interface ModerateResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  category_scores: Record<string, number>;
}

/** Validate moderation input. Returns error message or null. */
export function validateModerateInput(body: { text?: string }): string | null {
  if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
    return "Text is required";
  }
  if (body.text.length > MAX_TEXT_LENGTH) {
    return `Text must be ${MAX_TEXT_LENGTH} characters or less`;
  }
  return null;
}

/** Moderate text via OpenAI Moderation API. */
export async function moderateText(text: string): Promise<ModerateResult> {
  if (!OPENAI_API_KEY) {
    throw new ModerateError(503, "Moderation service not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODERATE_TIMEOUT_MS);

  try {
    const resp = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ input: text }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error("OpenAI moderation error:", resp.status, errBody);
      throw new ModerateError(503, "Moderation provider error");
    }

    const data = await resp.json() as {
      results?: {
        flagged: boolean;
        categories: Record<string, boolean>;
        category_scores: Record<string, number>;
      }[];
    };

    const result = data.results?.[0];
    if (!result) {
      throw new ModerateError(503, "Moderation provider returned empty response");
    }

    return {
      flagged: result.flagged,
      categories: result.categories,
      category_scores: result.category_scores,
    };
  } catch (err) {
    if (err instanceof ModerateError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new ModerateError(504, "Moderation request timed out");
    }
    throw new ModerateError(503, "Moderation provider unavailable");
  } finally {
    clearTimeout(timeout);
  }
}
