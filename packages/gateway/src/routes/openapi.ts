/**
 * OpenAPI discovery — /openapi.json
 *
 * Proxies and caches the canonical spec from run402.com/openapi.json.
 * The static site spec is the single source of truth.
 */

import { Router, Request, Response } from "express";

const router = Router();

let cachedSpec: string | null = null;
let cachedAt = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

router.get("/openapi.json", async (_req: Request, res: Response) => {
  try {
    if (!cachedSpec || Date.now() - cachedAt > CACHE_TTL) {
      const r = await fetch("https://run402.com/openapi.json");
      if (!r.ok) throw new Error(`Upstream ${r.status}`);
      cachedSpec = await r.text();
      cachedAt = Date.now();
    }
    res.set("Content-Type", "application/json");
    res.set("Cache-Control", "public, max-age=300");
    res.send(cachedSpec);
  } catch {
    // Serve stale cache if available
    if (cachedSpec) {
      res.set("Content-Type", "application/json");
      res.send(cachedSpec);
    } else {
      res.status(502).json({ error: "OpenAPI spec temporarily unavailable" });
    }
  }
});

export default router;
