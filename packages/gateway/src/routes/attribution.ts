/**
 * Ad attribution beacon endpoint.
 *
 * Receives browser-side beacons when users copy the run402/bld402 URL,
 * storing gclid + UTM data for later correlation with API conversions.
 *
 * Correlation strategy: time-window based. If a user copies the URL and
 * their agent creates a project within N minutes, attribute the conversion
 * to the ad campaign that brought them.
 */

import { Router, Request, Response } from "express";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";

const router = Router();

/**
 * POST /attribution/v1 — Browser beacon on copy-click
 *
 * Body: { gclid, utm_source, utm_medium, utm_campaign, utm_term, utm_content, page }
 * All fields optional except gclid (if no gclid, still useful for organic tracking).
 */
router.post("/attribution/v1", asyncHandler(async (req: Request, res: Response) => {
  const {
    gclid,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_term,
    utm_content,
    page,
  } = req.body || {};

  // At minimum we need something to track
  if (!gclid && !utm_source) {
    throw new HttpError(400, "Missing gclid or utm_source");
  }

  const ip = req.ip || "unknown";
  const userAgent = req.headers["user-agent"] || "";

  await pool.query(
    sql(`INSERT INTO internal.ad_attribution
       (gclid, utm_source, utm_medium, utm_campaign, utm_term, utm_content, page, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`),
    [
      gclid || null,
      utm_source || null,
      utm_medium || null,
      utm_campaign || null,
      utm_term || null,
      utm_content || null,
      page || null,
      ip,
      userAgent.slice(0, 512),
    ],
  );

  res.status(204).send();
}));

/**
 * GET /attribution/v1/recent — List recent attribution beacons (admin/debug)
 *
 * Query: ?minutes=30&limit=50
 */
router.get("/attribution/v1/recent", asyncHandler(async (req: Request, res: Response) => {
  const minutes = Math.min(parseInt(req.query.minutes as string) || 60, 1440);
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  const result = await pool.query(
    sql(`SELECT id, gclid, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
            page, ip, created_at
     FROM internal.ad_attribution
     WHERE created_at > NOW() - INTERVAL '1 minute' * $1
     ORDER BY created_at DESC
     LIMIT $2`),
    [minutes, limit],
  );

  res.json({ beacons: result.rows, count: result.rows.length });
}));

export default router;
