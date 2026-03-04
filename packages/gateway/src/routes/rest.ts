import { Router, Request, Response } from "express";
import { POSTGREST_URL } from "../config.js";
import { apikeyAuth } from "../middleware/apikey.js";
import { meteringMiddleware } from "../middleware/metering.js";
import { errorMessage } from "../utils/errors.js";

const router = Router();

// Retry delay for 404s caused by PostgREST schema cache staleness (ms).
// After DDL changes, PostgREST receives a NOTIFY and reloads its schema cache.
// Requests arriving in the brief window before the reload completes get a 404.
// A single retry after this delay is enough — PostgREST blocks requests during
// reload, so the retry will wait for the fresh cache automatically.
const SCHEMA_CACHE_RETRY_DELAY_MS = 150;

/**
 * Send a request to PostgREST and return the raw response.
 */
async function forwardToPostgREST(
  url: string,
  fetchOptions: RequestInit,
): Promise<{ status: number; text: string; contentType: string | null; contentRange: string | null }> {
  const pgResponse = await fetch(url, fetchOptions);
  return {
    status: pgResponse.status,
    text: await pgResponse.text(),
    contentType: pgResponse.headers.get("content-type"),
    contentRange: pgResponse.headers.get("content-range"),
  };
}

// PostgREST proxy — /rest/v1/*
router.all("/rest/v1/*", apikeyAuth, meteringMiddleware, async (req: Request, res: Response) => {
  const project = req.project!;

  // Build PostgREST URL
  const restPath = (req.params as Record<string, string>)[0];
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

    let result = await forwardToPostgREST(url, fetchOptions);

    // Retry once on 404 — PostgREST's schema cache may be stale after DDL.
    // The NOTIFY from the DDL transaction triggers an async reload; this retry
    // bridges the gap. PostgREST blocks requests during reload, so the retry
    // will see the fresh cache.
    if (result.status === 404) {
      await new Promise((r) => setTimeout(r, SCHEMA_CACHE_RETRY_DELAY_MS));
      result = await forwardToPostgREST(url, fetchOptions);
    }

    // Forward status and response
    res.status(result.status);
    if (result.contentType) res.set("Content-Type", result.contentType);
    if (result.contentRange) res.set("Content-Range", result.contentRange);
    res.send(result.text);
  } catch (err: unknown) {
    const msg = errorMessage(err);
    console.error("PostgREST proxy error:", msg);
    res.status(502).json({ error: "PostgREST proxy error: " + msg });
  }
});

export default router;
