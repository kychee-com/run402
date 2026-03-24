import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { JWT_SECRET, GOOGLE_APP_CLIENT_ID, GOOGLE_APP_CLIENT_SECRET, PUBLIC_API_URL } from "../config.js";
import { apikeyAuth } from "../middleware/apikey.js";
import { demoSignupMiddleware } from "../middleware/demo.js";
import { hasCode } from "../utils/errors.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import { verifyGoogleIdToken } from "../services/google-oidc.js";
import {
  validateRedirectUrl,
  createOAuthTransaction,
  consumeOAuthTransaction,
  resolveOAuthIdentity,
  createAuthorizationCode,
  exchangeAuthorizationCode,
} from "../services/oauth.js";
import { projectCache } from "../services/projects.js";
import type { TokenPayload } from "@run402/shared";

const router = Router();

const GOOGLE_CALLBACK_URL = `${PUBLIC_API_URL}/auth/v1/oauth/google/callback`;

// --- Google OAuth callback (NOT behind apikeyAuth — Google won't send apikey) ---

router.get("/auth/v1/oauth/google/callback", asyncHandler(async (req: Request, res: Response) => {
  // Allow the popup to access window.opener and call window.close()
  res.set("Cross-Origin-Opener-Policy", "unsafe-none");

  const { code, state, error } = req.query as Record<string, string | undefined>;

  // Helper to redirect with error
  function redirectError(redirectUrl: string, mode: string, errorCode: string, clientState?: string) {
    if (mode === "popup") {
      res.set("Cache-Control", "no-store");
      res.type("html").send(popupErrorPage(redirectUrl, errorCode, clientState));
    } else {
      const u = new URL(redirectUrl);
      u.hash = `error=${encodeURIComponent(errorCode)}${clientState ? `&state=${encodeURIComponent(clientState)}` : ""}`;
      res.set("Cache-Control", "no-store");
      res.redirect(302, u.toString());
    }
  }

  // Google returned an error
  if (error || !code || !state) {
    // We can't recover the transaction without state — best effort redirect
    res.set("Cache-Control", "no-store");
    res.status(400).type("html").send(errorPage(error || "missing_params"));
    return;
  }

  // Consume OAuth transaction
  const tx = await consumeOAuthTransaction(state);
  if (!tx) {
    res.set("Cache-Control", "no-store");
    res.status(400).type("html").send(errorPage("invalid_or_expired_state"));
    return;
  }

  // Exchange Google authorization code for tokens
  let googleTokens: { id_token: string };
  try {
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_APP_CLIENT_ID,
        client_secret: GOOGLE_APP_CLIENT_SECRET,
        redirect_uri: GOOGLE_CALLBACK_URL,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResp.ok) {
      const errBody = await tokenResp.text();
      console.error("  Google token exchange failed:", errBody);
      return redirectError(tx.redirectUrl, tx.mode, "token_exchange_failed", tx.clientState);
    }

    googleTokens = await tokenResp.json() as { id_token: string };
  } catch (err) {
    console.error("  Google token exchange error:", err);
    return redirectError(tx.redirectUrl, tx.mode, "token_exchange_failed", tx.clientState);
  }

  // Verify ID token
  let claims;
  try {
    claims = await verifyGoogleIdToken(googleTokens.id_token, tx.nonce);
  } catch (err) {
    console.error("  Google id_token verification failed:", err);
    return redirectError(tx.redirectUrl, tx.mode, "id_token_invalid", tx.clientState);
  }

  // Resolve identity
  const project = projectCache.get(tx.projectId);
  const identity = await resolveOAuthIdentity({
    projectId: tx.projectId,
    provider: "google",
    providerSub: claims.sub,
    providerEmail: claims.email,
    emailVerified: claims.email_verified,
    displayName: claims.name,
    avatarUrl: claims.picture,
    intent: tx.intent,
    linkingUserId: tx.linkingUserId,
    project: project || undefined,
  });

  if (identity.action === "account_exists_requires_link") {
    return redirectError(tx.redirectUrl, tx.mode, "account_exists_requires_link", tx.clientState);
  }

  if (identity.action === "identity_already_linked") {
    return redirectError(tx.redirectUrl, tx.mode, "identity_already_linked", tx.clientState);
  }

  if (!identity.userId) {
    return redirectError(tx.redirectUrl, tx.mode, "identity_resolution_failed", tx.clientState);
  }

  // Create Run402 authorization code
  const authCode = await createAuthorizationCode({
    userId: identity.userId,
    projectId: tx.projectId,
    redirectUrl: tx.redirectUrl,
    codeChallenge: tx.codeChallenge,
    codeChallengeMethod: tx.codeChallengeMethod,
    clientState: tx.clientState,
  });

  // Deliver to app
  res.set("Cache-Control", "no-store");
  if (tx.mode === "popup") {
    res.type("html").send(popupSuccessPage(tx.redirectUrl, authCode, tx.clientState));
  } else {
    const u = new URL(tx.redirectUrl);
    u.hash = `code=${encodeURIComponent(authCode)}${tx.clientState ? `&state=${encodeURIComponent(tx.clientState)}` : ""}`;
    res.redirect(302, u.toString());
  }
}));

// --- All other auth routes require apikey (anon_key) ---
router.use("/auth/v1", apikeyAuth);

// GET /auth/v1/providers — discover available auth providers
router.get("/auth/v1/providers", asyncHandler(async (_req: Request, res: Response) => {
  const googleEnabled = !!GOOGLE_APP_CLIENT_ID;
  res.set("Cache-Control", "no-store");
  res.json({
    password: { enabled: true },
    oauth: [
      {
        provider: "google",
        enabled: googleEnabled,
        display_name: "Google",
      },
    ],
  });
}));

// POST /auth/v1/oauth/google/start — initiate Google OAuth flow
router.post("/auth/v1/oauth/google/start", asyncHandler(async (req: Request, res: Response) => {
  if (!GOOGLE_APP_CLIENT_ID) {
    throw new HttpError(503, "Google OAuth is not configured");
  }

  const project = req.project!;
  const {
    redirect_url,
    mode = "redirect",
    intent = "signin",
    code_challenge,
    code_challenge_method,
    client_state,
    login_hint,
  } = req.body || {};

  if (!redirect_url) {
    throw new HttpError(400, "redirect_url required");
  }

  if (mode !== "popup" && mode !== "redirect") {
    throw new HttpError(400, "mode must be 'popup' or 'redirect'");
  }

  if (intent !== "signin" && intent !== "link") {
    throw new HttpError(400, "intent must be 'signin' or 'link'");
  }

  // Validate redirect URL
  const valid = await validateRedirectUrl(redirect_url, project.id);
  if (!valid) {
    throw new HttpError(400, "redirect_url is not an allowed origin for this project");
  }

  // If intent=link, require Bearer token
  let linkingUserId: string | undefined;
  if (intent === "link") {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      throw new HttpError(401, "Intent 'link' requires a Bearer token");
    }
    try {
      const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as TokenPayload;
      if (payload.role !== "authenticated" || payload.project_id !== project.id) {
        throw new HttpError(401, "Invalid user token for linking");
      }
      linkingUserId = payload.sub;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(401, "Invalid Bearer token");
    }
  }

  // Create OAuth transaction
  const { state, nonce } = await createOAuthTransaction({
    projectId: project.id,
    provider: "google",
    redirectUrl: redirect_url,
    mode,
    intent,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method || (code_challenge ? "S256" : undefined),
    linkingUserId,
    clientState: client_state,
  });

  // Build Google authorization URL
  const googleAuthUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleAuthUrl.searchParams.set("client_id", GOOGLE_APP_CLIENT_ID);
  googleAuthUrl.searchParams.set("redirect_uri", GOOGLE_CALLBACK_URL);
  googleAuthUrl.searchParams.set("response_type", "code");
  googleAuthUrl.searchParams.set("scope", "openid email profile");
  googleAuthUrl.searchParams.set("state", state);
  googleAuthUrl.searchParams.set("nonce", nonce);
  googleAuthUrl.searchParams.set("prompt", "select_account");
  if (login_hint) {
    googleAuthUrl.searchParams.set("login_hint", login_hint);
  }

  res.set("Cache-Control", "no-store");
  res.json({
    provider: "google",
    authorization_url: googleAuthUrl.toString(),
    expires_in: 600,
  });
}));

// POST /auth/v1/signup — create user (email normalization added)
router.post("/auth/v1/signup", demoSignupMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const project = req.project!;
  const { email: rawEmail, password } = req.body || {};

  if (!rawEmail || !password) {
    throw new HttpError(400, "email and password required");
  }

  const email = rawEmail.toLowerCase().trim();

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO internal.users (project_id, email, password_hash)
       VALUES ($1, $2, $3) RETURNING id, email, created_at`,
      [project.id, email, passwordHash],
    );

    const user = result.rows[0];
    console.log(`  User signed up: ${email} (project: ${project.id})`);

    res.set("Cache-Control", "no-store");
    res.status(201).json({
      id: user.id,
      email: user.email,
      created_at: user.created_at,
    });
  } catch (err: unknown) {
    if (hasCode(err) && err.code === "23505") {
      throw new HttpError(409, "User already exists");
    }
    throw err;
  }
}));

// POST /auth/v1/token — login, return JWT + refresh token
router.post("/auth/v1/token", asyncHandler(async (req: Request, res: Response) => {
  const project = req.project!;
  const grantType = req.query.grant_type as string | undefined;

  // Refresh token flow
  if (grantType === "refresh_token") {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      throw new HttpError(400, "refresh_token required");
    }

    const result = await pool.query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.used, u.email
       FROM internal.refresh_tokens rt
       JOIN internal.users u ON u.id = rt.user_id
       WHERE rt.id = $1::uuid AND rt.project_id = $2`,
      [refresh_token, project.id],
    );

    if (result.rows.length === 0) {
      throw new HttpError(401, "Invalid refresh token");
    }

    const token = result.rows[0];
    if (token.used) {
      throw new HttpError(401, "Refresh token already used");
    }
    if (new Date(token.expires_at) < new Date()) {
      throw new HttpError(401, "Refresh token expired");
    }

    // Mark old token as used
    await pool.query(`UPDATE internal.refresh_tokens SET used = true WHERE id = $1::uuid`, [refresh_token]);

    // Issue new tokens
    const accessToken = jwt.sign(
      { sub: token.user_id, role: "authenticated", project_id: project.id },
      JWT_SECRET,
      { expiresIn: "1h" },
    );
    const newRefreshToken = await createRefreshToken(token.user_id, project.id);

    res.set("Cache-Control", "no-store");
    res.json({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: newRefreshToken,
      user: { id: token.user_id, email: token.email },
    });
    return;
  }

  // Authorization code flow (OAuth)
  if (grantType === "authorization_code") {
    const { code, code_verifier } = req.body || {};
    if (!code) {
      throw new HttpError(400, "code required");
    }

    const result = await exchangeAuthorizationCode(code, code_verifier);
    if (!result) {
      throw new HttpError(401, "Invalid, expired, or already used authorization code");
    }

    if (result.projectId !== project.id) {
      throw new HttpError(401, "Authorization code was issued for a different project");
    }

    // Fetch user email
    const userResult = await pool.query(
      `SELECT id, email, display_name, avatar_url, email_verified_at FROM internal.users WHERE id = $1::uuid`,
      [result.userId],
    );
    if (userResult.rows.length === 0) {
      throw new HttpError(401, "User not found");
    }
    const user = userResult.rows[0];

    const accessToken = jwt.sign(
      { sub: result.userId, role: "authenticated", project_id: project.id },
      JWT_SECRET,
      { expiresIn: "1h" },
    );
    const refreshToken = await createRefreshToken(result.userId, project.id);

    console.log(`  OAuth login: ${user.email} (project: ${project.id})`);

    res.set("Cache-Control", "no-store");
    res.json({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
      user: {
        id: user.id,
        email: user.email,
        email_verified_at: user.email_verified_at || null,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
      },
      provider: "google",
    });
    return;
  }

  // Password login flow
  const { email: rawEmail, password } = req.body || {};
  if (!rawEmail || !password) {
    throw new HttpError(400, "email and password required");
  }

  const email = rawEmail.toLowerCase().trim();

  const result = await pool.query(
    `SELECT id, password_hash FROM internal.users
     WHERE project_id = $1 AND LOWER(email) = $2`,
    [project.id, email],
  );

  if (result.rows.length === 0) {
    throw new HttpError(401, "Invalid credentials");
  }

  const user = result.rows[0];

  // Guard: social-only users have null password_hash
  if (!user.password_hash) {
    throw new HttpError(401, "This account uses social login. Sign in with Google instead.");
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new HttpError(401, "Invalid credentials");
  }

  // Update last_sign_in_at
  await pool.query(`UPDATE internal.users SET last_sign_in_at = NOW() WHERE id = $1::uuid`, [user.id]);

  const accessToken = jwt.sign(
    { sub: user.id, role: "authenticated", project_id: project.id },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
  const refreshToken = await createRefreshToken(user.id, project.id);

  console.log(`  User logged in: ${email} (project: ${project.id})`);

  res.set("Cache-Control", "no-store");
  res.json({
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
    user: { id: user.id, email },
  });
}));

// GET /auth/v1/user — get current user from Bearer token
router.get("/auth/v1/user", asyncHandler(async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    throw new HttpError(401, "Missing Bearer token");
  }

  const project = req.project!;

  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as TokenPayload;
    if (payload.role !== "authenticated") {
      throw new HttpError(401, "Not an authenticated user token");
    }

    // Enforce project scoping
    if (payload.project_id !== project.id) {
      throw new HttpError(401, "Token was issued for a different project");
    }

    const result = await pool.query(
      `SELECT id, email, email_verified_at, display_name, avatar_url, last_sign_in_at, created_at
       FROM internal.users WHERE id = $1::uuid AND project_id = $2`,
      [payload.sub, project.id],
    );

    if (result.rows.length === 0) {
      throw new HttpError(404, "User not found");
    }

    const user = result.rows[0];

    // Fetch linked identities
    const identities = await pool.query(
      `SELECT provider, provider_sub, provider_email, created_at
       FROM internal.auth_identities WHERE user_id = $1::uuid`,
      [user.id],
    );

    res.set("Cache-Control", "no-store");
    res.json({
      id: user.id,
      email: user.email,
      email_verified_at: user.email_verified_at,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      last_sign_in_at: user.last_sign_in_at,
      created_at: user.created_at,
      identities: identities.rows,
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(401, "Invalid token");
  }
}));

// POST /auth/v1/logout — invalidate refresh token
router.post("/auth/v1/logout", asyncHandler(async (req: Request, res: Response) => {
  const { refresh_token } = req.body;
  if (refresh_token) {
    await pool.query(`UPDATE internal.refresh_tokens SET used = true WHERE id = $1::uuid`, [refresh_token]);
  }
  res.set("Cache-Control", "no-store");
  res.json({ status: "ok" });
}));

// Helper: create a refresh token
async function createRefreshToken(userId: string, projectId: string): Promise<string> {
  const tokenId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await pool.query(
    `INSERT INTO internal.refresh_tokens (id, user_id, project_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [tokenId, userId, projectId, expiresAt.toISOString()],
  );

  return tokenId;
}

// --- Popup response pages ---

function popupSuccessPage(redirectUrl: string, code: string, clientState?: string): string {
  const origin = new URL(redirectUrl).origin;
  const payload = JSON.stringify({
    type: "run402:oauth:callback",
    code,
    state: clientState || null,
  });
  return `<!DOCTYPE html>
<html><head><title>Signing in...</title></head>
<body>
<p id="msg">Signing you in...</p>
<script>
  if (window.opener) {
    window.opener.postMessage(${escapeJs(payload)}, ${escapeJs(JSON.stringify(origin))});
  }
  try { window.close(); } catch(e) {}
  setTimeout(function() { document.getElementById("msg").textContent = "Signed in! You can close this window."; }, 300);
</script>
</body></html>`;
}

function popupErrorPage(redirectUrl: string, errorCode: string, clientState?: string): string {
  const origin = new URL(redirectUrl).origin;
  const payload = JSON.stringify({
    type: "run402:oauth:error",
    error: errorCode,
    state: clientState || null,
  });
  return `<!DOCTYPE html>
<html><head><title>Sign in error</title></head>
<body>
<p id="msg">Sign in failed: ${escapeHtml(errorCode)}</p>
<script>
  if (window.opener) {
    window.opener.postMessage(${escapeJs(payload)}, ${escapeJs(JSON.stringify(origin))});
  }
  try { window.close(); } catch(e) {}
  setTimeout(function() { document.getElementById("msg").textContent = "You can close this window."; }, 300);
</script>
</body></html>`;
}

function errorPage(errorCode: string): string {
  return `<!DOCTYPE html>
<html><head><title>OAuth Error</title></head>
<body>
<h1>Sign in failed</h1>
<p>Error: ${escapeHtml(errorCode)}</p>
<p>Please close this window and try again.</p>
</body></html>`;
}

/** Escape a string for safe embedding inside a <script> block (prevents </script> breakout). */
function escapeJs(str: string): string {
  return str.replace(/<\//g, "<\\/");
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default router;
