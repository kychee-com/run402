/**
 * API Documentation Alignment Test
 *
 * Ensures every public gateway endpoint is documented in both llms.txt and
 * openapi.json, and vice versa. Catches undocumented endpoints and stale
 * docs for removed endpoints.
 *
 * Run: npx tsx --test test/api-docs-alignment.test.ts
 *   or: npm run test:docs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dirname, "..");
const ROUTES_DIR = join(ROOT, "packages/gateway/src/routes");
const SERVER_TS = join(ROOT, "packages/gateway/src/server.ts");
const LLMS_TXT = join(ROOT, "site/llms.txt");
const OPENAPI_JSON = join(ROOT, "site/openapi.json");

/**
 * Endpoints intentionally NOT documented in llms.txt / openapi.
 * Internal dashboards, webhooks, infrastructure, admin-only ops.
 * Uses normalized form (param names → {_}).
 */
const EXCLUDED_ENDPOINTS = new Set([
  // Admin dashboard (human-only, Google OAuth session auth)
  "GET /admin/login",
  "GET /admin/oauth/google",
  "GET /admin/oauth/google/callback",
  "GET /admin/logout",
  "GET /admin",
  "GET /admin/api/stats",
  "GET /admin/api/llms-txt-stats",
  "GET /admin/llms-txt",
  // Infrastructure / internal probes
  "GET /health-humans",
  "GET /status",
  "GET /public/stats",
  // Attribution beacon (internal analytics)
  "POST /x402/attribution",
  "GET /x402/attribution/recent",
  // Stripe webhook (called by Stripe, not by agents)
  "POST /v1/webhooks/stripe",
  // Billing admin (internal, admin-key only)
  "POST /v1/billing/admin/accounts/{_}/credit",
  "POST /v1/billing/admin/accounts/{_}/debit",
  // Admin-only operations (admin-key, not agent-facing)
  "POST /admin/v1/projects/{_}/pin",
  "POST /admin/v1/projects/{_}/unpin",
  "POST /admin/v1/faucet",
  // Admin delete app version (admin-key only)
  "DELETE /v1/admin/app-versions/{_}",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an endpoint to canonical form for comparison.
 * Erases param names so {table}, {path}, {wallet}, {address} all → {_}.
 */
function normalize(method: string, path: string): string {
  const m = method.toUpperCase();
  let p = path
    .replace(/YOUR_WALLET_ADDRESS/g, "{_}")
    .replace(/:(\w+)/g, "{_}")       // Express :param
    .replace(/\{[^}]+\}/g, "{_}")    // OpenAPI {param}
    .replace(/\/\*$/g, "/{_}")       // trailing wildcard
    .replace(/\/\*\//g, "/{_}/")     // mid-path wildcard
    .replace(/\?.*$/, "")            // query params
    .replace(/\/+$/, "");            // trailing slash
  if (!p.startsWith("/")) p = "/" + p;
  return `${m} ${p}`;
}

/**
 * Check if route `r` exists in set `b`, or if `r` is a literal example
 * that matches a parameterized route in `b`.
 *
 * e.g. "POST /v1/fork/prototype" matches "POST /v1/fork/{_}" in `b`.
 */
function existsIn(r: string, b: Set<string>): boolean {
  if (b.has(r)) return true;

  // Try replacing the last literal segment with {_}
  const spaceIdx = r.indexOf(" ");
  const method = r.slice(0, spaceIdx);
  const path = r.slice(spaceIdx + 1);
  const segments = path.split("/");
  const lastSeg = segments[segments.length - 1];
  if (lastSeg && lastSeg !== "{_}") {
    const candidate = [...segments];
    candidate[segments.length - 1] = "{_}";
    if (b.has(`${method} ${candidate.join("/")}`)) return true;
  }

  return false;
}

/**
 * Asymmetric difference: items in `a` that don't exist in `b`,
 * accounting for literal→param equivalence.
 */
function difference(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => !existsIn(x, b)).sort();
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/** Extract all route definitions from gateway source files */
function extractGatewayRoutes(): Set<string> {
  const routes = new Set<string>();

  const routePattern =
    /(?:router|app)\.(get|post|put|patch|delete|all)\(\s*(?:\[([^\]]+)\]|"([^"]+)")/g;

  const files = readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
    .map((f) => join(ROUTES_DIR, f));
  files.push(SERVER_TS);

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    let match: RegExpExecArray | null;
    while ((match = routePattern.exec(src)) !== null) {
      const method = match[1].toUpperCase();
      const arrayPaths = match[2];
      const singlePath = match[3];

      const paths = arrayPaths
        ? arrayPaths.match(/"([^"]+)"/g)?.map((s) => s.replace(/"/g, "")) || []
        : singlePath
          ? [singlePath]
          : [];

      for (const p of paths) {
        if (isMiddlewareOnly(file, p, src)) continue;

        if (method === "ALL") {
          for (const m of ["GET", "POST", "PATCH", "DELETE"]) {
            routes.add(normalize(m, p));
          }
        } else {
          routes.add(normalize(method, p));
        }
      }
    }
  }

  // Deduplicate sub-path catch-alls: "/functions/v1/{_}/{_}" → "/functions/v1/{_}"
  const deduped = new Set<string>();
  for (const r of routes) {
    const subPathMatch = r.match(/^(\w+ .*\/\{_\})\/\{_\}$/);
    if (subPathMatch && routes.has(subPathMatch[1])) continue;
    deduped.add(r);
  }

  return deduped;
}

/** Detect middleware-only registrations in server.ts */
function isMiddlewareOnly(file: string, path: string, src: string): boolean {
  if (!file.endsWith("server.ts")) return false;

  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lineRegex = new RegExp(`app\\.\\w+\\("${escapedPath}"[^)]*\\)`, "g");
  const lineMatch = lineRegex.exec(src);
  if (!lineMatch) return false;

  return (
    lineMatch[0].includes("idempotencyMiddleware") ||
    lineMatch[0].includes("express.raw")
  );
}

/** Extract endpoint docs from llms.txt — tables + freestanding code blocks */
function extractLlmsTxtEndpoints(): Set<string> {
  const routes = new Set<string>();
  const src = readFileSync(LLMS_TXT, "utf8");

  // 1. Markdown table rows: | `/path` | METHOD | ... |
  const tableRowPattern =
    /\|\s*`([^`]+)`\s*\|\s*(GET|POST|PUT|PATCH|DELETE|ALL)\s*\|/g;
  let match: RegExpExecArray | null;
  while ((match = tableRowPattern.exec(src)) !== null) {
    routes.add(normalize(match[2], match[1]));
  }

  // 2. Freestanding code blocks: "METHOD /path" on its own line
  const codeBlockPattern =
    /^(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s?{(]+)/gm;
  while ((match = codeBlockPattern.exec(src)) !== null) {
    let path = match[2].replace(/\/{2,}/g, "/");
    if (path.includes("://")) continue;
    routes.add(normalize(match[1], path));
  }

  return routes;
}

/** Extract endpoints from openapi.json */
function extractOpenApiEndpoints(): Set<string> {
  const routes = new Set<string>();
  const spec = JSON.parse(readFileSync(OPENAPI_JSON, "utf8"));

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of Object.keys(methods as object)) {
      if (["get", "post", "put", "patch", "delete"].includes(method)) {
        routes.add(normalize(method, path));
      }
    }
  }

  return routes;
}

/** Filter out excluded endpoints */
function filterExcluded(routes: Set<string>): Set<string> {
  const filtered = new Set<string>();
  for (const r of routes) {
    if (!EXCLUDED_ENDPOINTS.has(r)) filtered.add(r);
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const gateway = filterExcluded(extractGatewayRoutes());
const llmsTxt = extractLlmsTxtEndpoints();
const openapi = filterExcluded(extractOpenApiEndpoints());

describe("API ↔ llms.txt alignment", () => {
  it("every gateway endpoint is documented in llms.txt", () => {
    const missing = difference(gateway, llmsTxt);
    if (missing.length > 0) {
      assert.fail(
        `${missing.length} gateway endpoint(s) missing from llms.txt:\n` +
          missing.map((e) => `  - ${e}`).join("\n") +
          "\n\nAdd docs to site/llms.txt or add to EXCLUDED_ENDPOINTS.",
      );
    }
  });

  it("llms.txt does not document removed endpoints", () => {
    const stale = difference(llmsTxt, gateway);
    if (stale.length > 0) {
      assert.fail(
        `${stale.length} llms.txt endpoint(s) not found in gateway:\n` +
          stale.map((e) => `  - ${e}`).join("\n") +
          "\n\nRemove stale docs from site/llms.txt or check the route.",
      );
    }
  });
});

describe("API ↔ openapi.json alignment", () => {
  it("every gateway endpoint is documented in openapi.json", () => {
    const missing = difference(gateway, openapi);
    if (missing.length > 0) {
      assert.fail(
        `${missing.length} gateway endpoint(s) missing from openapi.json:\n` +
          missing.map((e) => `  - ${e}`).join("\n") +
          "\n\nAdd to site/openapi.json or add to EXCLUDED_ENDPOINTS.",
      );
    }
  });

  it("openapi.json does not document removed endpoints", () => {
    const stale = difference(openapi, gateway);
    if (stale.length > 0) {
      assert.fail(
        `${stale.length} openapi.json endpoint(s) not found in gateway:\n` +
          stale.map((e) => `  - ${e}`).join("\n") +
          "\n\nRemove stale docs from site/openapi.json or check the route.",
      );
    }
  });
});

describe("llms.txt ↔ openapi.json alignment", () => {
  it("every llms.txt endpoint is in openapi.json", () => {
    const missing = difference(llmsTxt, openapi);
    if (missing.length > 0) {
      assert.fail(
        `${missing.length} llms.txt endpoint(s) missing from openapi.json:\n` +
          missing.map((e) => `  - ${e}`).join("\n"),
      );
    }
  });

  it("every openapi.json endpoint is in llms.txt", () => {
    const missing = difference(openapi, llmsTxt);
    if (missing.length > 0) {
      assert.fail(
        `${missing.length} openapi.json endpoint(s) missing from llms.txt:\n` +
          missing.map((e) => `  - ${e}`).join("\n"),
      );
    }
  });
});
