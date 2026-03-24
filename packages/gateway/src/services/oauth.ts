/**
 * OAuth service layer — state management, identity resolution, code exchange,
 * redirect validation, and cleanup for the Google social login flow.
 */

import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { getDemoCounters } from "../middleware/demo.js";
import { DEFAULT_DEMO_CONFIG } from "@run402/shared";
import type { ProjectInfo } from "@run402/shared";

// --- Helpers ---

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

// --- Redirect validation ---

/**
 * Validate that a redirect URL is allowed for the given project.
 * Allowed: http://localhost:*, http://127.0.0.1:*, https://{claimed-subdomain}.run402.com
 */
export async function validateRedirectUrl(url: string, projectId: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Allow localhost (any port)
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
    if (parsed.protocol === "http:") return true;
    return false;
  }

  // Allow claimed subdomains for this project
  if (parsed.protocol === "https:" && parsed.hostname.endsWith(".run402.com")) {
    const subName = parsed.hostname.replace(/\.run402\.com$/, "");
    const result = await pool.query(
      sql(`SELECT 1 FROM internal.subdomains WHERE project_id = $1 AND name = $2`),
      [projectId, subName],
    );
    return result.rows.length > 0;
  }

  return false;
}

// --- OAuth transactions ---

export interface OAuthTransactionParams {
  projectId: string;
  provider: string;
  redirectUrl: string;
  mode: string;
  intent: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  linkingUserId?: string;
  clientState?: string;
}

export interface OAuthTransaction {
  id: string;
  projectId: string;
  provider: string;
  redirectUrl: string;
  mode: string;
  intent: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  nonce: string;
  linkingUserId?: string;
  clientState?: string;
}

/**
 * Create an OAuth transaction row with 10-minute TTL.
 * Returns { state, nonce } for the authorization URL.
 */
export async function createOAuthTransaction(
  params: OAuthTransactionParams,
): Promise<{ state: string; nonce: string }> {
  const state = randomToken();
  const nonce = randomToken();
  const stateHash = sha256(state);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

  await pool.query(
    sql(`INSERT INTO internal.oauth_transactions
       (project_id, provider, state_hash, code_challenge, code_challenge_method,
        redirect_url, mode, intent, nonce, linking_user_id, client_state, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`),
    [
      params.projectId,
      params.provider,
      stateHash,
      params.codeChallenge || null,
      params.codeChallengeMethod || null,
      params.redirectUrl,
      params.mode,
      params.intent,
      nonce,
      params.linkingUserId || null,
      params.clientState || null,
      expiresAt.toISOString(),
    ],
  );

  return { state, nonce };
}

/**
 * Consume an OAuth transaction by state value (one-time use).
 * Deletes the row and returns the full record, or null if not found/expired.
 */
export async function consumeOAuthTransaction(stateValue: string): Promise<OAuthTransaction | null> {
  const stateHash = sha256(stateValue);

  const result = await pool.query(
    sql(`DELETE FROM internal.oauth_transactions
     WHERE state_hash = $1 AND expires_at > NOW()
     RETURNING id, project_id, provider, redirect_url, mode, intent,
               code_challenge, code_challenge_method, nonce,
               linking_user_id, client_state`),
    [stateHash],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider,
    redirectUrl: row.redirect_url,
    mode: row.mode,
    intent: row.intent,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    nonce: row.nonce,
    linkingUserId: row.linking_user_id,
    clientState: row.client_state,
  };
}

// --- Identity resolution ---

export type IdentityAction = "signin" | "signup" | "linked" | "account_exists_requires_link" | "identity_already_linked";

export interface IdentityResult {
  action: IdentityAction;
  userId?: string;
  email?: string;
  error?: string;
}

export interface ResolveIdentityParams {
  projectId: string;
  provider: string;
  providerSub: string;
  providerEmail: string;
  emailVerified: boolean;
  displayName?: string;
  avatarUrl?: string;
  intent: string;
  linkingUserId?: string;
  project?: ProjectInfo;
}

/**
 * Resolve OAuth identity to a project user.
 *
 * Cases:
 * 1. Identity already linked → sign in
 * 2. Intent=link with authenticated user → link or error
 * 3. Same email exists → account_exists_requires_link
 * 4. No account → create user + identity
 */
export async function resolveOAuthIdentity(params: ResolveIdentityParams): Promise<IdentityResult> {
  const email = params.providerEmail.toLowerCase().trim();

  // Case 1: check if identity already exists
  const existing = await pool.query(
    sql(`SELECT ai.user_id, u.email FROM internal.auth_identities ai
     JOIN internal.users u ON u.id = ai.user_id
     WHERE ai.project_id = $1 AND ai.provider = $2 AND ai.provider_sub = $3`),
    [params.projectId, params.provider, params.providerSub],
  );

  if (existing.rows.length > 0) {
    const userId = existing.rows[0].user_id;
    // Update last_sign_in_at
    await pool.query(
      sql(`UPDATE internal.users SET last_sign_in_at = NOW() WHERE id = $1::uuid`),
      [userId],
    );
    await pool.query(
      sql(`UPDATE internal.auth_identities SET provider_email = $1, updated_at = NOW()
       WHERE project_id = $2 AND provider = $3 AND provider_sub = $4`),
      [email, params.projectId, params.provider, params.providerSub],
    );
    return { action: "signin", userId, email: existing.rows[0].email };
  }

  // Case 2: linking flow
  if (params.intent === "link" && params.linkingUserId) {
    // Check if this identity is already linked to another user
    // (already checked above — not found, so it's free)
    await pool.query(
      sql(`INSERT INTO internal.auth_identities
         (user_id, project_id, provider, provider_sub, provider_email, provider_data)
       VALUES ($1, $2, $3, $4, $5, $6)`),
      [
        params.linkingUserId,
        params.projectId,
        params.provider,
        params.providerSub,
        email,
        JSON.stringify({ name: params.displayName, picture: params.avatarUrl }),
      ],
    );
    // Update user profile if fields are empty
    await pool.query(
      sql(`UPDATE internal.users SET
         display_name = COALESCE(display_name, $2),
         avatar_url = COALESCE(avatar_url, $3),
         email_verified_at = CASE WHEN email_verified_at IS NULL AND $4 THEN NOW() ELSE email_verified_at END,
         last_sign_in_at = NOW()
       WHERE id = $1::uuid`),
      [params.linkingUserId, params.displayName || null, params.avatarUrl || null, params.emailVerified],
    );
    return { action: "linked", userId: params.linkingUserId, email };
  }

  // Case 3: check if same email exists in project
  const emailMatch = await pool.query(
    sql(`SELECT id FROM internal.users WHERE project_id = $1 AND LOWER(email) = $2`),
    [params.projectId, email],
  );

  if (emailMatch.rows.length > 0) {
    return { action: "account_exists_requires_link", email };
  }

  // Case 4: create new user + identity
  // Check demo limits
  if (params.project?.demoMode) {
    const config = params.project.demoConfig || DEFAULT_DEMO_CONFIG;
    const c = getDemoCounters(params.projectId);
    if (c.signups >= config.max_auth_users) {
      return { action: "account_exists_requires_link", error: "demo_signup_limit_reached" };
    }
    c.signups++;
  }

  const userResult = await pool.query(
    sql(`INSERT INTO internal.users (project_id, email, password_hash, email_verified_at, display_name, avatar_url, last_sign_in_at)
     VALUES ($1, $2, NULL, $3, $4, $5, NOW())
     RETURNING id`),
    [
      params.projectId,
      email,
      params.emailVerified ? new Date().toISOString() : null,
      params.displayName || null,
      params.avatarUrl || null,
    ],
  );

  const userId = userResult.rows[0].id;

  await pool.query(
    sql(`INSERT INTO internal.auth_identities
       (user_id, project_id, provider, provider_sub, provider_email, provider_data)
     VALUES ($1, $2, $3, $4, $5, $6)`),
    [
      userId,
      params.projectId,
      params.provider,
      params.providerSub,
      email,
      JSON.stringify({ name: params.displayName, picture: params.avatarUrl }),
    ],
  );

  console.log(`  OAuth signup: ${email} via ${params.provider} (project: ${params.projectId})`);

  return { action: "signup", userId, email };
}

// --- Authorization codes ---

/**
 * Create a short-lived one-time auth code (5-minute TTL).
 * Stores SHA-256(code) + optional PKCE challenge.
 */
export async function createAuthorizationCode(params: {
  userId: string;
  projectId: string;
  redirectUrl: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  clientState?: string;
}): Promise<string> {
  const code = randomToken();
  const codeHash = sha256(code);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min

  await pool.query(
    sql(`INSERT INTO internal.oauth_codes
       (code_hash, code_challenge, code_challenge_method, user_id, project_id, redirect_url, client_state, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`),
    [
      codeHash,
      params.codeChallenge || null,
      params.codeChallengeMethod || null,
      params.userId,
      params.projectId,
      params.redirectUrl,
      params.clientState || null,
      expiresAt.toISOString(),
    ],
  );

  return code;
}

/**
 * Exchange a one-time auth code for user/project info.
 * Verifies PKCE if a code_challenge was stored.
 * Returns null if code is invalid, expired, or already used.
 */
export async function exchangeAuthorizationCode(
  code: string,
  codeVerifier?: string,
): Promise<{ userId: string; projectId: string } | null> {
  const codeHash = sha256(code);

  const result = await pool.query(
    sql(`UPDATE internal.oauth_codes
     SET used = true
     WHERE code_hash = $1 AND expires_at > NOW() AND used = false
     RETURNING user_id, project_id, code_challenge, code_challenge_method`),
    [codeHash],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];

  // PKCE verification
  if (row.code_challenge) {
    if (!codeVerifier) return null;
    const method = row.code_challenge_method || "S256";
    if (method === "S256") {
      const expected = sha256(codeVerifier);
      if (expected !== row.code_challenge) return null;
    } else if (method === "plain") {
      if (codeVerifier !== row.code_challenge) return null;
    } else {
      return null;
    }
  }

  return { userId: row.user_id, projectId: row.project_id };
}

// --- Cleanup ---

/**
 * Delete expired OAuth transactions and codes.
 * Called on an hourly interval.
 */
export async function cleanupExpiredOAuthData(): Promise<void> {
  try {
    const txResult = await pool.query(
      sql(`DELETE FROM internal.oauth_transactions WHERE expires_at < NOW()`),
    );
    const codeResult = await pool.query(
      sql(`DELETE FROM internal.oauth_codes WHERE expires_at < NOW()`),
    );
    const total = (txResult.rowCount || 0) + (codeResult.rowCount || 0);
    if (total > 0) {
      console.log(`  OAuth cleanup: removed ${txResult.rowCount} transactions, ${codeResult.rowCount} codes`);
    }
  } catch (err) {
    console.error("  OAuth cleanup error:", err);
  }
}
