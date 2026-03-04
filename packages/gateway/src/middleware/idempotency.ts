import { Request, Response, NextFunction } from "express";
import { pool } from "../db/pool.js";

const IDEMPOTENCY_TTL_HOURS = 24;

/**
 * Ensure the idempotency_keys table exists (called once at startup).
 */
export async function initIdempotencyTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS internal.idempotency_keys (
      key TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_body JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Clean up expired keys periodically
  await pool.query(`
    DELETE FROM internal.idempotency_keys
    WHERE created_at < now() - interval '${IDEMPOTENCY_TTL_HOURS} hours'
  `);
}

/**
 * Idempotency middleware for paid endpoints.
 * If Idempotency-Key header is present, check for cached response.
 * If found, return cached response. If not, proceed and cache the result.
 */
export function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

  if (!idempotencyKey) {
    next();
    return;
  }

  // Validate key format (non-empty, reasonable length)
  if (idempotencyKey.length > 256) {
    res.status(400).json({ error: "Idempotency-Key too long (max 256 characters)" });
    return;
  }

  const compositeKey = `${req.method}:${req.path}:${idempotencyKey}`;

  pool.query(
    `SELECT status_code, response_body, method, path FROM internal.idempotency_keys WHERE key = $1`,
    [compositeKey],
  ).then((result) => {
    if (result.rows.length > 0) {
      const cached = result.rows[0];
      // Verify method and path match
      if (cached.method !== req.method || cached.path !== req.path) {
        res.status(422).json({
          error: "Idempotency-Key already used with a different request",
        });
        return;
      }
      // Return cached response
      res.status(cached.status_code).json(cached.response_body);
      return;
    }

    // Override res.json to capture the response
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      // Cache successful responses (2xx)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        pool.query(
          `INSERT INTO internal.idempotency_keys (key, method, path, status_code, response_body)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (key) DO NOTHING`,
          [compositeKey, req.method, req.path, res.statusCode, JSON.stringify(body)],
        ).catch((err: unknown) => {
          console.error("Failed to cache idempotency key:", err instanceof Error ? err.message : err);
        });
      }
      return originalJson(body);
    } as typeof res.json;

    next();
  }).catch((err) => {
    console.error("Idempotency check failed:", err.message);
    // On DB error, proceed without idempotency (don't block requests)
    next();
  });
}
