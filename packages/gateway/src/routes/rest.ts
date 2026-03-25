import { Router, Request, Response } from "express";
import { POSTGREST_URL } from "../config.js";
import { apikeyAuth } from "../middleware/apikey.js";
import { meteringMiddleware } from "../middleware/metering.js";
import { demoRestMiddleware } from "../middleware/demo.js";
import { asyncHandler } from "../utils/async-handler.js";

const router = Router();

// Retry config for PostgREST schema cache staleness.
// After DDL + RLS setup, PostgREST reloads all 2000 schema slots on NOTIFY.
// Production reload takes 1-3s. Retries poll until the table/column appears.
const SCHEMA_CACHE_RETRY_DELAY_MS = 500;
const SCHEMA_CACHE_MAX_RETRIES = 6;

/**
 * Detect PostgREST errors caused by a stale schema cache.
 * - 404: table/view not found (PGRST200)
 * - 400 with PGRST204: column not found in schema cache
 */
function isSchemaCacheError(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status === 400) {
    try {
      const parsed = JSON.parse(body);
      return parsed.code === "PGRST204";
    } catch { return false; }
  }
  return false;
}

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

  // Retry on schema cache staleness — covers both missing tables (404)
  // and missing columns on existing tables (400 / PGRST204).
  let retries = 0;
  while (isSchemaCacheError(result.status, result.text) && retries < SCHEMA_CACHE_MAX_RETRIES) {
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
