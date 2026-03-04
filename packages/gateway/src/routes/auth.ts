import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { JWT_SECRET } from "../config.js";
import { apikeyAuth } from "../middleware/apikey.js";
import { hasCode } from "../utils/errors.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import type { TokenPayload } from "@run402/shared";

const router = Router();

// All auth routes require apikey (anon_key)
router.use("/auth/v1", apikeyAuth);

// POST /auth/v1/signup — create user
router.post("/auth/v1/signup", asyncHandler(async (req: Request, res: Response) => {
  const project = req.project!;
  const { email, password } = req.body || {};

  if (!email || !password) {
    throw new HttpError(400, "email and password required");
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO internal.users (project_id, email, password_hash)
       VALUES ($1, $2, $3) RETURNING id, email, created_at`,
      [project.id, email, passwordHash],
    );

    const user = result.rows[0];
    console.log(`  User signed up: ${email} (project: ${project.id})`);

    res.json({
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
       WHERE rt.id = $1 AND rt.project_id = $2`,
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
    await pool.query(`UPDATE internal.refresh_tokens SET used = true WHERE id = $1`, [refresh_token]);

    // Issue new tokens
    const accessToken = jwt.sign(
      { sub: token.user_id, role: "authenticated", project_id: project.id },
      JWT_SECRET,
      { expiresIn: "1h" },
    );
    const newRefreshToken = await createRefreshToken(token.user_id, project.id);

    res.json({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: newRefreshToken,
      user: { id: token.user_id, email: token.email },
    });
    return;
  }

  // Password login flow
  const { email, password } = req.body || {};
  if (!email || !password) {
    throw new HttpError(400, "email and password required");
  }

  const result = await pool.query(
    `SELECT id, password_hash FROM internal.users
     WHERE project_id = $1 AND email = $2`,
    [project.id, email],
  );

  if (result.rows.length === 0) {
    throw new HttpError(401, "Invalid credentials");
  }

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new HttpError(401, "Invalid credentials");
  }

  const accessToken = jwt.sign(
    { sub: user.id, role: "authenticated", project_id: project.id },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
  const refreshToken = await createRefreshToken(user.id, project.id);

  console.log(`  User logged in: ${email} (project: ${project.id})`);

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

  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as TokenPayload;
    if (payload.role !== "authenticated") {
      throw new HttpError(401, "Not an authenticated user token");
    }

    const result = await pool.query(
      `SELECT id, email, created_at FROM internal.users WHERE id = $1`,
      [payload.sub],
    );

    if (result.rows.length === 0) {
      throw new HttpError(404, "User not found");
    }

    res.json(result.rows[0]);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(401, "Invalid token");
  }
}));

// POST /auth/v1/logout — invalidate refresh token
router.post("/auth/v1/logout", asyncHandler(async (req: Request, res: Response) => {
  const { refresh_token } = req.body;
  if (refresh_token) {
    await pool.query(`UPDATE internal.refresh_tokens SET used = true WHERE id = $1`, [refresh_token]);
  }
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

export default router;
