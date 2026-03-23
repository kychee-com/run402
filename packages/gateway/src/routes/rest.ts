import { Router, Request, Response } from "express";
import { POSTGREST_URL } from "../config.js";
import { apikeyAuth } from "../middleware/apikey.js";
import { meteringMiddleware } from "../middleware/metering.js";
import { demoRestMiddleware } from "../middleware/demo.js";
import { asyncHandler } from "../utils/async-handler.js";

const router = Router();

// Retry config for 404s caused by PostgREST schema cache staleness.
// After DDL + RLS setup, PostgREST may need up to ~1s to reload its schema
// via NOTIFY (production has 2000 schema slots). Retries poll until ready.
const SCHEMA_CACHE_RETRY_DELAY_MS = 200;
const SCHEMA_CACHE_MAX_RETRIES = 5;

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
router.all("/rest/v1/*splat", apikeyAuth, meteringMiddleware, demoRestMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const project = req.project!;

  // Build PostgREST URL
  const splat = (req.params as Record<string, string | string[]>)["splat"];
  const restPath = Array.isArray(splat) ? splat.join("/") : splat;
  const queryString = new URLSearchParams(req.query as Record<string, string>).toString();
  const url = `${POSTGREST_URL}/${restPath}${queryString ? "?" + queryString : ""}`;

  // Build headers for PostgREST
  const headers: Record<string, string> = {
    "Accept-Profile": project.schemaSlot,
    "Content-Profile": project.schemaSlot,
  };

  if (req.headers.authorization) {
    headers["Authorization"] = req.headers.authorization as string;
  } else if (req.headers["apikey"]) {
    headers["Authorization"] = `Bearer ${req.headers["apikey"]}`;
  }

  if (req.headers["content-type"]) {
    headers["Content-Type"] = req.headers["content-type"] as string;
  }

  if (req.headers["prefer"]) {
    headers["Prefer"] = req.headers["prefer"] as string;
  }

  const fetchOptions: RequestInit = {
    method: req.method,
    headers,
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    fetchOptions.body = JSON.stringify(req.body);
  }

  let result = await forwardToPostgREST(url, fetchOptions);

  // Retry on 404 — PostgREST's schema cache may be stale after DDL + RLS.
  let retries = 0;
  while (result.status === 404 && retries < SCHEMA_CACHE_MAX_RETRIES) {
    await new Promise((r) => setTimeout(r, SCHEMA_CACHE_RETRY_DELAY_MS));
    result = await forwardToPostgREST(url, fetchOptions);
    retries++;
  }

  res.status(result.status);
  if (result.contentType) res.set("Content-Type", result.contentType);
  if (result.contentRange) res.set("Content-Range", result.contentRange);
  res.send(result.text);
}));

export default router;
