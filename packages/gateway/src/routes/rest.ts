import { Router, Request, Response } from "express";
import { POSTGREST_URL } from "../config.js";
import { apikeyAuth } from "../middleware/apikey.js";
import { meteringMiddleware } from "../middleware/metering.js";

const router = Router();

// PostgREST proxy — /rest/v1/*
router.all("/rest/v1/*", apikeyAuth, meteringMiddleware, async (req: Request, res: Response) => {
  const project = req.project!;

  // Build PostgREST URL
  const restPath = (req.params as any)[0] as string;
  const queryString = new URLSearchParams(req.query as Record<string, string>).toString();
  const url = `${POSTGREST_URL}/${restPath}${queryString ? "?" + queryString : ""}`;

  // Build headers for PostgREST
  const headers: Record<string, string> = {
    "Accept-Profile": project.schemaSlot,
    "Content-Profile": project.schemaSlot,
  };

  // Forward Authorization header (user JWT for RLS).
  // If no Authorization header, auto-forward the apikey token so PostgREST
  // receives a valid JWT (avoids requiring both apikey + Authorization headers).
  if (req.headers.authorization) {
    headers["Authorization"] = req.headers.authorization as string;
  } else if (req.headers["apikey"]) {
    headers["Authorization"] = `Bearer ${req.headers["apikey"]}`;
  }

  // Forward content type
  if (req.headers["content-type"]) {
    headers["Content-Type"] = req.headers["content-type"] as string;
  }

  // Forward Prefer header (for return=representation, etc.)
  if (req.headers["prefer"]) {
    headers["Prefer"] = req.headers["prefer"] as string;
  }

  try {
    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };

    // Forward body for non-GET requests
    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const pgResponse = await fetch(url, fetchOptions);

    // Forward status and response
    const responseText = await pgResponse.text();
    res.status(pgResponse.status);

    // Forward relevant response headers
    const ct = pgResponse.headers.get("content-type");
    if (ct) res.set("Content-Type", ct);
    const cr = pgResponse.headers.get("content-range");
    if (cr) res.set("Content-Range", cr);

    res.send(responseText);
  } catch (err: any) {
    console.error("PostgREST proxy error:", err.message);
    res.status(502).json({ error: "PostgREST proxy error: " + err.message });
  }
});

export default router;
