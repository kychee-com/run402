/**
 * AI routes — translate and moderate content.
 *
 * POST /ai/v1/translate — Translate text (service_key auth, requires translation add-on)
 * POST /ai/v1/moderate  — Moderate text (service_key auth, free for all projects)
 * GET  /ai/v1/usage     — Get translation usage for current billing period
 */

import { Router, Request, Response } from "express";
import { serviceKeyAuth } from "../middleware/apikey.js";
import { serviceKeyOrAdmin } from "../middleware/admin-auth.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { ADMIN_KEY } from "../config.js";
import {
  validateTranslateInput,
  translateText,
  logAiUsage,
  getTranslationAddon,
  getUsageForPeriod,
  tokensToWords,
  wordsToTokens,
  TranslateError,
} from "../services/ai-translate.js";
import {
  validateModerateInput,
  moderateText,
  ModerateError,
} from "../services/ai-moderate.js";

const router = Router();

// --- Per-project rate limiting ---
const translateRateLimits = new Map<string, { count: number; resetAt: number }>();
const moderateRateLimits = new Map<string, { count: number; resetAt: number }>();
const TRANSLATE_RATE_LIMIT = 60;  // per minute
const MODERATE_RATE_LIMIT = 120;  // per minute

function checkRateLimit(
  limits: Map<string, { count: number; resetAt: number }>,
  projectId: string,
  maxPerMinute: number,
): void {
  const now = Date.now();
  const entry = limits.get(projectId);
  if (!entry || now > entry.resetAt) {
    limits.set(projectId, { count: 1, resetAt: now + 60_000 });
    return;
  }
  entry.count++;
  if (entry.count > maxPerMinute) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    const err = new HttpError(429, "Rate limit exceeded", { retry_after: retryAfter });
    throw err;
  }
}

// POST /ai/v1/translate
router.post("/ai/v1/translate", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.project!.id;

  // Rate limit
  checkRateLimit(translateRateLimits, projectId, TRANSLATE_RATE_LIMIT);

  // Validate input
  const validationError = validateTranslateInput(req.body || {});
  if (validationError) {
    throw new HttpError(400, validationError);
  }

  const { text, to, from, context } = req.body;

  // Check translation add-on
  const addon = await getTranslationAddon(projectId);
  if (!addon) {
    throw new HttpError(402, "Translation add-on required. Purchase an AI Translation package to use this endpoint.");
  }

  // Check quota
  const usedTokens = await getUsageForPeriod(projectId, "translate", addon.billing_cycle_start);
  if (usedTokens >= addon.included_tokens) {
    throw new HttpError(402, "Translation word limit reached. Upgrade your AI Translation package for more words.");
  }

  // Same source and target language — short circuit
  if (from && from.toLowerCase() === to.toLowerCase()) {
    res.json({ text, from: from.toLowerCase(), to: to.toLowerCase() });
    return;
  }

  try {
    const result = await translateText(text, to.toLowerCase(), {
      from: from?.toLowerCase(),
      context,
    });

    // Log usage (fire-and-forget)
    logAiUsage(projectId, "translate", result.input_tokens, result.output_tokens, result.model);

    res.json({ text: result.text, from: result.from, to: result.to });
  } catch (err) {
    if (err instanceof TranslateError) {
      throw new HttpError(err.statusCode, err.message);
    }
    throw err;
  }
}));

// POST /ai/v1/moderate
router.post("/ai/v1/moderate", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.project!.id;

  // Rate limit
  checkRateLimit(moderateRateLimits, projectId, MODERATE_RATE_LIMIT);

  // Validate input
  const validationError = validateModerateInput(req.body || {});
  if (validationError) {
    throw new HttpError(400, validationError);
  }

  const { text } = req.body;

  try {
    const result = await moderateText(text);
    res.json(result);
  } catch (err) {
    if (err instanceof ModerateError) {
      throw new HttpError(err.statusCode, err.message);
    }
    throw err;
  }
}));

// GET /ai/v1/usage — get translation usage for current billing period
router.get("/ai/v1/usage", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.project!.id;

  const addon = await getTranslationAddon(projectId);
  if (!addon) {
    res.json({
      translation: {
        active: false,
        used_words: 0,
        included_words: 0,
        remaining_words: 0,
        billing_cycle_start: null,
      },
    });
    return;
  }

  const usedTokens = await getUsageForPeriod(projectId, "translate", addon.billing_cycle_start);
  const usedWords = tokensToWords(usedTokens);
  const includedWords = tokensToWords(addon.included_tokens);
  const remainingWords = Math.max(0, includedWords - usedWords);

  res.json({
    translation: {
      active: true,
      used_words: usedWords,
      included_words: includedWords,
      remaining_words: remainingWords,
      billing_cycle_start: addon.billing_cycle_start.toISOString(),
    },
  });
}));

// POST /ai/v1/addons — activate a translation add-on for a project (admin only)
router.post("/ai/v1/addons", asyncHandler(async (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string;
  if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
    throw new HttpError(401, "Admin key required");
  }

  const { project_id, addon_type, included_words } = req.body || {};

  if (!project_id || typeof project_id !== "string") {
    throw new HttpError(400, "Missing or invalid 'project_id'");
  }
  if (addon_type !== "translation") {
    throw new HttpError(400, "addon_type must be 'translation'");
  }
  if (!included_words || typeof included_words !== "number" || included_words <= 0) {
    throw new HttpError(400, "included_words must be a positive number");
  }

  const includedTokens = wordsToTokens(included_words);

  await pool.query(
    sql(`INSERT INTO internal.ai_addons (project_id, addon_type, included_tokens, billing_cycle_start, status)
         VALUES ($1, $2, $3, NOW(), 'active')
         ON CONFLICT (project_id, addon_type) DO UPDATE SET included_tokens = $3, billing_cycle_start = NOW(), status = 'active'`),
    [project_id, addon_type, includedTokens],
  );

  res.status(201).json({
    project_id,
    addon_type,
    included_words,
    included_tokens: includedTokens,
    status: "active",
  });
}));

// DELETE /ai/v1/addons — deactivate a translation add-on (admin only)
router.delete("/ai/v1/addons", asyncHandler(async (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string;
  if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
    throw new HttpError(401, "Admin key required");
  }

  const { project_id, addon_type } = req.body || {};

  if (!project_id || typeof project_id !== "string") {
    throw new HttpError(400, "Missing or invalid 'project_id'");
  }
  if (addon_type !== "translation") {
    throw new HttpError(400, "addon_type must be 'translation'");
  }

  const result = await pool.query(
    sql(`UPDATE internal.ai_addons SET status = 'inactive' WHERE project_id = $1 AND addon_type = $2 AND status = 'active' RETURNING *`),
    [project_id, addon_type],
  );

  if (result.rows.length === 0) {
    throw new HttpError(404, "No active add-on found for this project");
  }

  res.json({ status: "deactivated", project_id, addon_type });
}));

export default router;
