/**
 * Unit tests for the CloudFront Function: custom subdomain asset routing.
 *
 * Tests the function logic in isolation (subdomain extraction, KVS lookup,
 * URI rewriting, error handling) by simulating the CloudFront event format.
 *
 * Run: node --test --import tsx infra/test/cf-function-asset-routing.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------- Simulate the CloudFront Function environment ----------

interface CfRequest {
  uri: string;
  headers: Record<string, { value: string }>;
}

interface CfEvent {
  request: CfRequest;
}

interface CfResponse {
  statusCode: number;
  statusDescription: string;
  body?: { encoding: string; data: string };
}

/**
 * Extracted logic from the CloudFront Function in custom-subdomains-stack.ts.
 * This mirrors the function exactly for testability.
 */
async function handler(
  event: CfEvent,
  kvsGet: (key: string) => Promise<string>,
): Promise<CfRequest | CfResponse> {
  const request = event.request;
  const host = (request.headers.host && request.headers.host.value) || "";

  // Extract subdomain: "myapp.run402.com" → "myapp"
  const dotIndex = host.indexOf(".");
  if (dotIndex < 1) {
    return {
      statusCode: 400,
      statusDescription: "Bad Request",
      body: { encoding: "text", data: "Invalid host" },
    };
  }
  const subdomain = host.substring(0, dotIndex);

  // Look up deployment ID in KVS
  let deploymentId: string;
  try {
    deploymentId = await kvsGet(subdomain);
  } catch {
    return {
      statusCode: 404,
      statusDescription: "Not Found",
      body: { encoding: "text", data: "Subdomain not configured" },
    };
  }

  // Rewrite URI to S3 prefix
  request.uri = "/sites/" + deploymentId + request.uri;
  return request;
}

// ---------- Tests ----------

function makeEvent(host: string, uri: string): CfEvent {
  return {
    request: {
      uri,
      headers: { host: { value: host } },
    },
  };
}

function mockKvs(entries: Record<string, string>) {
  return async (key: string): Promise<string> => {
    if (key in entries) return entries[key];
    throw new Error("Key not found");
  };
}

describe("CloudFront Function: asset routing", () => {
  describe("subdomain extraction", () => {
    it("extracts subdomain from standard host", async () => {
      const result = await handler(
        makeEvent("myapp.run402.com", "/style.css"),
        mockKvs({ myapp: "dpl_abc123" }),
      );
      assert.equal("uri" in result, true);
      assert.equal((result as CfRequest).uri, "/sites/dpl_abc123/style.css");
    });

    it("returns 404 for bare domain (no matching KVS entry)", async () => {
      const result = await handler(
        makeEvent("run402.com", "/style.css"),
        mockKvs({}),
      );
      // "run402" extracted as subdomain, KVS lookup fails → 404
      assert.equal((result as CfResponse).statusCode, 404);
    });

    it("returns 400 for empty host", async () => {
      const result = await handler(
        { request: { uri: "/style.css", headers: { host: { value: "" } } } },
        mockKvs({}),
      );
      assert.equal((result as CfResponse).statusCode, 400);
    });

    it("handles hyphenated subdomains", async () => {
      const result = await handler(
        makeEvent("my-cool-app.run402.com", "/app.js"),
        mockKvs({ "my-cool-app": "dpl_xyz789" }),
      );
      assert.equal((result as CfRequest).uri, "/sites/dpl_xyz789/app.js");
    });
  });

  describe("KVS lookup", () => {
    it("returns 404 when subdomain not in KVS", async () => {
      const result = await handler(
        makeEvent("unknown.run402.com", "/style.css"),
        mockKvs({}),
      );
      assert.equal((result as CfResponse).statusCode, 404);
      assert.equal(
        (result as CfResponse).body?.data,
        "Subdomain not configured",
      );
    });

    it("resolves known subdomain to deployment ID", async () => {
      const result = await handler(
        makeEvent("cosmic.run402.com", "/logo.png"),
        mockKvs({ cosmic: "dpl_1234_abcd" }),
      );
      assert.equal(
        (result as CfRequest).uri,
        "/sites/dpl_1234_abcd/logo.png",
      );
    });
  });

  describe("URI rewriting", () => {
    it("rewrites root-relative paths", async () => {
      const result = await handler(
        makeEvent("app.run402.com", "/assets/main.js"),
        mockKvs({ app: "dpl_001" }),
      );
      assert.equal(
        (result as CfRequest).uri,
        "/sites/dpl_001/assets/main.js",
      );
    });

    it("rewrites nested paths", async () => {
      const result = await handler(
        makeEvent("app.run402.com", "/static/css/theme.css"),
        mockKvs({ app: "dpl_002" }),
      );
      assert.equal(
        (result as CfRequest).uri,
        "/sites/dpl_002/static/css/theme.css",
      );
    });

    it("handles favicon.ico at root", async () => {
      const result = await handler(
        makeEvent("app.run402.com", "/favicon.ico"),
        mockKvs({ app: "dpl_003" }),
      );
      assert.equal(
        (result as CfRequest).uri,
        "/sites/dpl_003/favicon.ico",
      );
    });
  });
});
