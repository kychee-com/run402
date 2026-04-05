/**
 * Magic link service — token generation, verification, rate limiting, and cleanup
 * for passwordless email authentication.
 */

import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import type { TierName } from "@run402/shared";

// --- Token management ---

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

/**
 * Create a magic link token for the given email and project.
 * Invalidates any previous active token for this email+project.
 * Returns the raw token (never stored — only the hash is persisted).
 */
export async function createMagicLinkToken(
  projectId: string,
  email: string,
  redirectUrl: string,
): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256(rawToken);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);

  // Invalidate any previous active token for this email+project
  await pool.query(
    sql(`UPDATE internal.magic_link_tokens SET used = true WHERE project_id = $1 AND LOWER(email) = $2 AND used = false AND expires_at > NOW()`),
    [projectId, email.toLowerCase()],
  );

  // Insert new token
  await pool.query(
    sql(`INSERT INTO internal.magic_link_tokens (token_hash, email, project_id, redirect_url, expires_at) VALUES ($1, $2, $3, $4, $5)`),
    [tokenHash, email.toLowerCase(), projectId, redirectUrl, expiresAt.toISOString()],
  );

  return rawToken;
}

/**
 * Verify a magic link token. Single-use: marks the token as used on success.
 * Returns { email, projectId, redirectUrl } or null if invalid/expired/used.
 */
export async function verifyMagicLinkToken(
  tokenValue: string,
): Promise<{ email: string; projectId: string; redirectUrl: string } | null> {
  const tokenHash = sha256(tokenValue);

  const result = await pool.query(
    sql(`UPDATE internal.magic_link_tokens SET used = true WHERE token_hash = $1 AND expires_at > NOW() AND used = false RETURNING email, project_id, redirect_url`),
    [tokenHash],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    email: row.email,
    projectId: row.project_id,
    redirectUrl: row.redirect_url,
  };
}

// --- Rate limiting (in-memory) ---

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const PER_EMAIL_LIMIT = 5;
const PER_PROJECT_LIMITS: Record<TierName, number> = {
  prototype: 50,
  hobby: 200,
  team: 1000,
};

// Key: `${projectId}:${email}` for per-email, `project:${projectId}` for per-project
const rateLimitMap = new Map<string, RateLimitEntry>();

function getRateLimitEntry(key: string): RateLimitEntry {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now >= entry.resetAt) {
    const newEntry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(key, newEntry);
    return newEntry;
  }
  return entry;
}

/**
 * Check if a magic link request is allowed under rate limits.
 * Returns { allowed: true } or { allowed: false, reason: "per_email" | "per_project" }.
 */
export function checkMagicLinkRateLimit(
  projectId: string,
  email: string,
  tier: TierName,
): { allowed: true } | { allowed: false; reason: "per_email" | "per_project" } {
  // Check per-email limit
  const emailKey = `${projectId}:${email.toLowerCase()}`;
  const emailEntry = getRateLimitEntry(emailKey);
  if (emailEntry.count >= PER_EMAIL_LIMIT) {
    return { allowed: false, reason: "per_email" };
  }

  // Check per-project limit
  const projectKey = `project:${projectId}`;
  const projectEntry = getRateLimitEntry(projectKey);
  const projectLimit = PER_PROJECT_LIMITS[tier] || PER_PROJECT_LIMITS.prototype;
  if (projectEntry.count >= projectLimit) {
    return { allowed: false, reason: "per_project" };
  }

  // Allowed — increment both counters
  emailEntry.count++;
  projectEntry.count++;

  return { allowed: true };
}

// --- Cleanup ---

/**
 * Delete expired magic link tokens.
 * Called from the existing OAuth cleanup interval.
 */
export async function cleanupExpiredMagicLinkTokens(): Promise<void> {
  try {
    const result = await pool.query(
      sql(`DELETE FROM internal.magic_link_tokens WHERE expires_at < NOW()`),
    );
    if (result.rowCount && result.rowCount > 0) {
      console.log(`  Magic link cleanup: removed ${result.rowCount} expired tokens`);
    }
  } catch (err) {
    console.error("  Magic link cleanup error:", err);
  }
}
