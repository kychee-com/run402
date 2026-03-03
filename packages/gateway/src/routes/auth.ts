import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { JWT_SECRET } from "../config.js";
import { apikeyAuth } from "../middleware/apikey.js";

const router = Router();

// All auth routes require apikey (anon_key)
router.use("/auth/v1", apikeyAuth);

// POST /auth/v1/signup — create user
router.post("/auth/v1/signup", async (req: Request, res: Response) => {
  const project = req.project!;
  const { email, password } = req.body || {};

  if (!email || !password) {
    res.status(400).json({ error: "email and password required" });
    return;
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
  } catch (err: any) {
    if (err.code === "23505") {
      res.status(409).json({ error: "User already exists" });
    } else {
      console.error("Signup error:", err.message);
      res.status(500).json({ error: "Signup failed" });
    }
  }
});

// POST /auth/v1/token — login, return JWT + refresh token
router.post("/auth/v1/token", async (req: Request, res: Response) => {
  const project = req.project!;
  const grantType = req.query.grant_type as string | undefined;

  // Refresh token flow
  if (grantType === "refresh_token") {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      res.status(400).json({ error: "refresh_token required" });
      return;
    }

    try {
      const result = await pool.query(
        `SELECT rt.id, rt.user_id, rt.expires_at, rt.used, u.email
         FROM internal.refresh_tokens rt
         JOIN internal.users u ON u.id = rt.user_id
         WHERE rt.id = $1 AND rt.project_id = $2`,
        [refresh_token, project.id],
      );

      if (result.rows.length === 0) {
        res.status(401).json({ error: "Invalid refresh token" });
        return;
      }

      const token = result.rows[0];
      if (token.used) {
        res.status(401).json({ error: "Refresh token already used" });
        return;
      }
      if (new Date(token.expires_at) < new Date()) {
        res.status(401).json({ error: "Refresh token expired" });
        return;
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
    } catch (err: any) {
      console.error("Refresh error:", err.message);
      res.status(500).json({ error: "Token refresh failed" });
    }
    return;
  }

  // Password login flow
  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(400).json({ error: "email and password required" });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT id, password_hash FROM internal.users
       WHERE project_id = $1 AND email = $2`,
      [project.id, email],
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
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
  } catch (err: any) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login failed" });
  }
});

// GET /auth/v1/user — get current user from Bearer token
router.get("/auth/v1/user", async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Bearer token" });
    return;
  }

  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as any;
    if (payload.role !== "authenticated") {
      res.status(401).json({ error: "Not an authenticated user token" });
      return;
    }

    const result = await pool.query(
      `SELECT id, email, created_at FROM internal.users WHERE id = $1`,
      [payload.sub],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json(result.rows[0]);
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
});

// POST /auth/v1/logout — invalidate refresh token
router.post("/auth/v1/logout", async (req: Request, res: Response) => {
  const { refresh_token } = req.body;
  if (refresh_token) {
    await pool.query(`UPDATE internal.refresh_tokens SET used = true WHERE id = $1`, [refresh_token]);
  }
  res.json({ status: "ok" });
});

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
