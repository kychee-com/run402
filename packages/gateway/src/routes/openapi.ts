/**
 * OpenAPI discovery — /openapi.json
 *
 * Redirects to the canonical spec hosted on the static site.
 * The spec at run402.com/openapi.json is the single source of truth.
 */

import { Router, Request, Response } from "express";

const router = Router();

router.get("/openapi.json", (_req: Request, res: Response) => {
  res.redirect(301, "https://run402.com/openapi.json");
});

export default router;
