/**
 * Robustness E2E Test — Malformed requests across all endpoints
 *
 * Ensures the gateway never returns 500 for bad input.
 * Every test sends a deliberately broken request and asserts the response
 * is a clean 4xx (400, 401, 402, 403, 404, 405, 409, 422, 429) — never 500.
 *
 * No x402 wallet or valid project needed — this only tests error handling.
 *
 * Usage:
 *   BASE_URL=https://api.run402.com npx tsx test/robustness-e2e.ts
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:4022";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

/** Send a request and assert status is NOT 500+ */
async function expectNot5xx(
  method: string,
  path: string,
  opts: {
    headers?: Record<string, string>;
    body?: string;
    label?: string;
    expectStatus?: number | number[];
  } = {},
) {
  const url = `${BASE_URL}${path}`;
  const label = opts.label || `${method} ${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: opts.headers,
      body: opts.body,
    });
    const status = res.status;
    if (status >= 500) {
      const body = await res.text().catch(() => "(unreadable)");
      assert(false, `${label} → ${status} (SERVER ERROR: ${body})`);
    } else if (opts.expectStatus) {
      const expected = Array.isArray(opts.expectStatus) ? opts.expectStatus : [opts.expectStatus];
      assert(expected.includes(status), `${label} → ${status} (expected ${expected.join("|")})`);
    } else {
      assert(true, `${label} → ${status}`);
    }
    return res;
  } catch (err: any) {
    assert(false, `${label} → NETWORK ERROR: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log("\n=== Robustness E2E Test ===\n");
  console.log(`Target: ${BASE_URL}\n`);

  // ──────────────────────────────────────────────
  // 1. JSON body parsing — malformed payloads
  // ──────────────────────────────────────────────
  console.log("--- 1. Malformed JSON bodies ---");

  const jsonEndpoints = [
    "/v1/projects",
    "/v1/projects/create/prototype",
    "/v1/faucet",
    "/v1/deployments",
    "/auth/v1/signup",
    "/auth/v1/token",
    "/auth/v1/logout",
    "/admin/v1/projects/fake-id/rls",
  ];

  const malformedBodies = [
    { body: "{invalid json", label: "truncated object" },
    { body: "{'single': 'quotes'}", label: "single quotes" },
    { body: "{\"key\": undefined}", label: "undefined value" },
    { body: "<html>not json</html>", label: "HTML instead of JSON" },
    { body: "null", label: "null literal" },
    { body: "42", label: "number literal" },
    { body: "\"just a string\"", label: "string literal" },
    { body: "[1,2,3]", label: "array instead of object" },
    { body: "", label: "empty string" },
    { body: "\x00\x01\x02", label: "binary garbage" },
    { body: "{\"a\":\"\x00\"}", label: "null byte in value" },
    { body: "{\n\"unclosed\": \"value\n}", label: "unescaped newline in string" },
  ];

  for (const endpoint of jsonEndpoints) {
    for (const { body, label } of malformedBodies) {
      await expectNot5xx("POST", endpoint, {
        headers: { "Content-Type": "application/json" },
        body,
        label: `POST ${endpoint} (${label})`,
      });
    }
  }

  // ──────────────────────────────────────────────
  // 2. Wrong Content-Type headers
  // ──────────────────────────────────────────────
  console.log("\n--- 2. Wrong Content-Type ---");

  const wrongContentTypes = [
    "text/plain",
    "text/html",
    "application/xml",
    "multipart/form-data",
    "application/x-www-form-urlencoded",
    "image/png",
    "application/octet-stream",
  ];

  for (const ct of wrongContentTypes) {
    await expectNot5xx("POST", "/v1/faucet", {
      headers: { "Content-Type": ct },
      body: "address=0x1234",
      label: `POST /v1/faucet (Content-Type: ${ct})`,
    });

    await expectNot5xx("POST", "/v1/deployments", {
      headers: { "Content-Type": ct },
      body: "name=test",
      label: `POST /v1/deployments (Content-Type: ${ct})`,
    });
  }

  // No Content-Type at all
  await expectNot5xx("POST", "/v1/faucet", {
    body: '{"address":"0x1234"}',
    label: "POST /v1/faucet (no Content-Type)",
  });

  await expectNot5xx("POST", "/v1/deployments", {
    body: '{"name":"test","files":[]}',
    label: "POST /v1/deployments (no Content-Type)",
  });

  // ──────────────────────────────────────────────
  // 3. Missing required fields
  // ──────────────────────────────────────────────
  console.log("\n--- 3. Missing required fields ---");

  // Faucet — missing address
  await expectNot5xx("POST", "/v1/faucet", {
    headers: { "Content-Type": "application/json" },
    body: "{}",
    label: "POST /v1/faucet (empty object, no address)",
    expectStatus: 400,
  });

  await expectNot5xx("POST", "/v1/faucet", {
    headers: { "Content-Type": "application/json" },
    body: '{"address":""}',
    label: "POST /v1/faucet (empty address)",
    expectStatus: 400,
  });

  // Auth signup — missing fields
  await expectNot5xx("POST", "/auth/v1/signup", {
    headers: { "Content-Type": "application/json", apikey: "fake-key" },
    body: "{}",
    label: "POST /auth/v1/signup (no email/password)",
  });

  await expectNot5xx("POST", "/auth/v1/signup", {
    headers: { "Content-Type": "application/json", apikey: "fake-key" },
    body: '{"email":"a@b.com"}',
    label: "POST /auth/v1/signup (no password)",
  });

  await expectNot5xx("POST", "/auth/v1/signup", {
    headers: { "Content-Type": "application/json", apikey: "fake-key" },
    body: '{"password":"secret"}',
    label: "POST /auth/v1/signup (no email)",
  });

  // Auth token — missing fields
  await expectNot5xx("POST", "/auth/v1/token", {
    headers: { "Content-Type": "application/json", apikey: "fake-key" },
    body: "{}",
    label: "POST /auth/v1/token (empty body)",
  });

  await expectNot5xx("POST", "/auth/v1/token?grant_type=refresh_token", {
    headers: { "Content-Type": "application/json", apikey: "fake-key" },
    body: "{}",
    label: "POST /auth/v1/token?grant_type=refresh_token (no token)",
  });

  // Deployments — missing fields
  await expectNot5xx("POST", "/v1/deployments", {
    headers: { "Content-Type": "application/json" },
    body: '{"name":"test"}',
    label: "POST /v1/deployments (no files array)",
  });

  await expectNot5xx("POST", "/v1/deployments", {
    headers: { "Content-Type": "application/json" },
    body: '{"files":[{"file":"index.html"}]}',
    label: "POST /v1/deployments (file missing data field)",
  });

  await expectNot5xx("POST", "/v1/deployments", {
    headers: { "Content-Type": "application/json" },
    body: '{"name":"test","files":[]}',
    label: "POST /v1/deployments (empty files array)",
  });

  // RLS — missing fields
  await expectNot5xx("POST", "/admin/v1/projects/fake-id/rls", {
    headers: { "Content-Type": "application/json", Authorization: "Bearer fake-key" },
    body: "{}",
    label: "POST /admin/.../rls (no template)",
  });

  await expectNot5xx("POST", "/admin/v1/projects/fake-id/rls", {
    headers: { "Content-Type": "application/json", Authorization: "Bearer fake-key" },
    body: '{"template":"user_owns_rows"}',
    label: "POST /admin/.../rls (no tables)",
  });

  // ──────────────────────────────────────────────
  // 4. Wrong data types for fields
  // ──────────────────────────────────────────────
  console.log("\n--- 4. Wrong data types ---");

  await expectNot5xx("POST", "/v1/faucet", {
    headers: { "Content-Type": "application/json" },
    body: '{"address":12345}',
    label: "POST /v1/faucet (address as number)",
  });

  await expectNot5xx("POST", "/v1/faucet", {
    headers: { "Content-Type": "application/json" },
    body: '{"address":true}',
    label: "POST /v1/faucet (address as boolean)",
  });

  await expectNot5xx("POST", "/v1/faucet", {
    headers: { "Content-Type": "application/json" },
    body: '{"address":["0x1234"]}',
    label: "POST /v1/faucet (address as array)",
  });

  await expectNot5xx("POST", "/auth/v1/signup", {
    headers: { "Content-Type": "application/json", apikey: "fake-key" },
    body: '{"email":123,"password":456}',
    label: "POST /auth/v1/signup (email/password as numbers)",
  });

  await expectNot5xx("POST", "/v1/deployments", {
    headers: { "Content-Type": "application/json" },
    body: '{"name":123,"files":"not-an-array"}',
    label: "POST /v1/deployments (name as number, files as string)",
  });

  await expectNot5xx("POST", "/v1/deployments", {
    headers: { "Content-Type": "application/json" },
    body: '{"name":"test","files":[{"file":123,"data":456}]}',
    label: "POST /v1/deployments (file/data as numbers)",
  });

  await expectNot5xx("POST", "/admin/v1/projects/fake-id/rls", {
    headers: { "Content-Type": "application/json", Authorization: "Bearer fake-key" },
    body: '{"template":123,"tables":"not-array"}',
    label: "POST /admin/.../rls (template as number, tables as string)",
  });

  // ──────────────────────────────────────────────
  // 5. Invalid auth headers
  // ──────────────────────────────────────────────
  console.log("\n--- 5. Invalid auth headers ---");

  // Missing apikey entirely
  await expectNot5xx("GET", "/rest/v1/anything", {
    label: "GET /rest/v1/anything (no apikey)",
  });

  await expectNot5xx("POST", "/rest/v1/anything", {
    headers: { "Content-Type": "application/json" },
    body: '{"key":"value"}',
    label: "POST /rest/v1/anything (no apikey)",
  });

  // Garbage apikey
  await expectNot5xx("GET", "/rest/v1/anything", {
    headers: { apikey: "not-a-jwt" },
    label: "GET /rest/v1/anything (garbage apikey)",
  });

  await expectNot5xx("GET", "/rest/v1/anything", {
    headers: { apikey: "" },
    label: "GET /rest/v1/anything (empty apikey)",
  });

  // Garbage Bearer token
  await expectNot5xx("GET", "/auth/v1/user", {
    headers: { Authorization: "Bearer not-a-jwt" },
    label: "GET /auth/v1/user (garbage Bearer)",
  });

  await expectNot5xx("GET", "/auth/v1/user", {
    headers: { Authorization: "Bearer " },
    label: "GET /auth/v1/user (empty Bearer)",
  });

  await expectNot5xx("GET", "/auth/v1/user", {
    headers: { Authorization: "not-bearer-scheme" },
    label: "GET /auth/v1/user (wrong auth scheme)",
  });

  await expectNot5xx("GET", "/auth/v1/user", {
    label: "GET /auth/v1/user (no auth header at all)",
  });

  // Admin endpoints with bad auth
  await expectNot5xx("POST", "/admin/v1/projects/fake-id/sql", {
    headers: { "Content-Type": "text/plain", Authorization: "Bearer garbage" },
    body: "SELECT 1",
    label: "POST /admin/.../sql (garbage Bearer)",
  });

  await expectNot5xx("POST", "/admin/v1/projects/fake-id/sql", {
    headers: { "Content-Type": "text/plain" },
    body: "SELECT 1",
    label: "POST /admin/.../sql (no auth)",
  });

  await expectNot5xx("GET", "/admin/v1/projects/fake-id/usage", {
    label: "GET /admin/.../usage (no auth)",
  });

  await expectNot5xx("GET", "/admin/v1/projects/fake-id/schema", {
    label: "GET /admin/.../schema (no auth)",
  });

  // Storage with bad auth
  await expectNot5xx("GET", "/storage/v1/object/bucket/file.txt", {
    label: "GET /storage/v1/object/... (no apikey)",
  });

  await expectNot5xx("POST", "/storage/v1/object/bucket/file.txt", {
    headers: { "Content-Type": "text/plain" },
    body: "file content",
    label: "POST /storage/v1/object/... (no apikey)",
  });

  await expectNot5xx("GET", "/storage/v1/object/list/bucket", {
    label: "GET /storage/v1/object/list/... (no apikey)",
  });

  // ──────────────────────────────────────────────
  // 6. Invalid path parameters
  // ──────────────────────────────────────────────
  console.log("\n--- 6. Invalid path parameters ---");

  // Non-existent project IDs
  await expectNot5xx("DELETE", "/v1/projects/nonexistent", {
    headers: { Authorization: "Bearer fake-key" },
    label: "DELETE /v1/projects/nonexistent",
  });

  await expectNot5xx("POST", "/v1/projects/nonexistent/renew", {
    headers: { "Content-Type": "application/json" },
    body: "{}",
    label: "POST /v1/projects/nonexistent/renew",
  });

  // Invalid tier
  await expectNot5xx("POST", "/v1/projects/create/invalid-tier", {
    headers: { "Content-Type": "application/json" },
    body: "{}",
    label: "POST /v1/projects/create/invalid-tier",
  });

  await expectNot5xx("POST", "/v1/projects/create/", {
    headers: { "Content-Type": "application/json" },
    body: "{}",
    label: "POST /v1/projects/create/ (empty tier)",
  });

  // Non-existent deployment
  await expectNot5xx("GET", "/v1/deployments/dpl_nonexistent", {
    label: "GET /v1/deployments/dpl_nonexistent",
    expectStatus: 404,
  });

  // SQL injection in path params
  await expectNot5xx("GET", "/v1/deployments/'; DROP TABLE deployments;--", {
    label: "GET /v1/deployments (SQL injection in path)",
  });

  await expectNot5xx("DELETE", "/v1/projects/'; DROP TABLE projects;--", {
    headers: { Authorization: "Bearer fake-key" },
    label: "DELETE /v1/projects (SQL injection in path)",
  });

  // Path traversal
  await expectNot5xx("GET", "/storage/v1/object/bucket/../../etc/passwd", {
    headers: { apikey: "fake-key" },
    label: "GET /storage/v1/object (path traversal)",
  });

  await expectNot5xx("GET", "/storage/v1/object/bucket/%2e%2e/%2e%2e/etc/passwd", {
    headers: { apikey: "fake-key" },
    label: "GET /storage/v1/object (encoded path traversal)",
  });

  // Very long path
  const longPath = "/v1/projects/" + "A".repeat(2000);
  await expectNot5xx("GET", longPath, {
    label: "GET /v1/projects/<2000-char ID>",
  });

  // ──────────────────────────────────────────────
  // 7. Unexpected HTTP methods
  // ──────────────────────────────────────────────
  console.log("\n--- 7. Unexpected HTTP methods ---");

  const methodEndpoints = [
    { path: "/health", validMethods: ["GET"] },
    { path: "/v1/faucet", validMethods: ["POST"] },
    { path: "/v1/projects/quote", validMethods: ["POST"] },
    { path: "/v1/projects", validMethods: ["POST"] },
    { path: "/v1/deployments", validMethods: ["POST"] },
    { path: "/auth/v1/signup", validMethods: ["POST"] },
    { path: "/auth/v1/token", validMethods: ["POST"] },
    { path: "/auth/v1/user", validMethods: ["GET"] },
  ];

  const allMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];

  for (const { path, validMethods } of methodEndpoints) {
    const invalidMethods = allMethods.filter((m) => !validMethods.includes(m));
    for (const method of invalidMethods) {
      await expectNot5xx(method, path, {
        headers: { "Content-Type": "application/json" },
        body: method !== "GET" ? "{}" : undefined,
        label: `${method} ${path} (wrong method)`,
      });
    }
  }

  // ──────────────────────────────────────────────
  // 8. Oversized & extreme payloads
  // ──────────────────────────────────────────────
  console.log("\n--- 8. Oversized & extreme payloads ---");

  // Very large JSON value
  const largeString = "x".repeat(2 * 1024 * 1024); // 2MB
  await expectNot5xx("POST", "/v1/faucet", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: largeString }),
    label: "POST /v1/faucet (2MB address string)",
  });

  // Deeply nested JSON
  let nested = '{"a":';
  for (let i = 0; i < 100; i++) nested += '{"a":';
  nested += '"deep"';
  for (let i = 0; i < 101; i++) nested += "}";
  await expectNot5xx("POST", "/v1/faucet", {
    headers: { "Content-Type": "application/json" },
    body: nested,
    label: "POST /v1/faucet (100-level nested JSON)",
  });

  // Very long header values
  await expectNot5xx("GET", "/rest/v1/anything", {
    headers: { apikey: "x".repeat(10000) },
    label: "GET /rest/v1/anything (10KB apikey header)",
  });

  await expectNot5xx("POST", "/v1/deployments", {
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "k".repeat(300),
    },
    body: '{"name":"test","files":[{"file":"index.html","data":"hi"}]}',
    label: "POST /v1/deployments (300-char Idempotency-Key)",
    expectStatus: 400,
  });

  // ──────────────────────────────────────────────
  // 9. Special characters & injection
  // ──────────────────────────────────────────────
  console.log("\n--- 9. Special characters & injection ---");

  // XSS in faucet address
  await expectNot5xx("POST", "/v1/faucet", {
    headers: { "Content-Type": "application/json" },
    body: '{"address":"<script>alert(1)</script>"}',
    label: "POST /v1/faucet (XSS in address)",
  });

  // SQL injection in body fields
  await expectNot5xx("POST", "/auth/v1/signup", {
    headers: { "Content-Type": "application/json", apikey: "fake-key" },
    body: '{"email":"admin@test.com\'; DROP TABLE users;--","password":"x"}',
    label: "POST /auth/v1/signup (SQL injection in email)",
  });

  // Unicode / emoji in fields
  await expectNot5xx("POST", "/v1/faucet", {
    headers: { "Content-Type": "application/json" },
    body: '{"address":"\\ud800"}',
    label: "POST /v1/faucet (lone surrogate in address)",
  });

  await expectNot5xx("POST", "/v1/deployments", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "\u0000\u0001\u0002", files: [{ file: "index.html", data: "hi" }] }),
    label: "POST /v1/deployments (control chars in name)",
  });

  // Null bytes in various positions
  await expectNot5xx("POST", "/auth/v1/token", {
    headers: { "Content-Type": "application/json", apikey: "fake-key" },
    body: '{"email":"test\u0000@evil.com","password":"pass"}',
    label: "POST /auth/v1/token (null byte in email)",
  });

  // ──────────────────────────────────────────────
  // 10. Edge cases — empty & duplicate headers
  // ──────────────────────────────────────────────
  console.log("\n--- 10. Edge cases ---");

  // OPTIONS (CORS preflight) on various endpoints
  for (const path of ["/v1/projects", "/v1/deployments", "/rest/v1/test", "/auth/v1/signup"]) {
    await expectNot5xx("OPTIONS", path, {
      headers: {
        Origin: "https://evil.com",
        "Access-Control-Request-Method": "POST",
      },
      label: `OPTIONS ${path} (CORS preflight)`,
      expectStatus: 204,
    });
  }

  // Double-slash paths
  await expectNot5xx("GET", "//health", {
    label: "GET //health (double slash)",
  });

  await expectNot5xx("GET", "/v1//deployments/test", {
    label: "GET /v1//deployments/test (double slash mid-path)",
  });

  // Trailing slashes
  await expectNot5xx("GET", "/health/", {
    label: "GET /health/ (trailing slash)",
  });

  // Query string on POST endpoints
  await expectNot5xx("POST", "/v1/faucet?extra=param&another=value", {
    headers: { "Content-Type": "application/json" },
    body: '{"address":"0x1234567890abcdef1234567890abcdef12345678"}',
    label: "POST /v1/faucet (unexpected query params)",
  });

  // HEAD requests
  await expectNot5xx("HEAD", "/health", {
    label: "HEAD /health",
  });

  await expectNot5xx("HEAD", "/v1/deployments/dpl_nonexistent", {
    label: "HEAD /v1/deployments/dpl_nonexistent",
  });

  // ──────────────────────────────────────────────
  // 11. SQL endpoint edge cases
  // ──────────────────────────────────────────────
  console.log("\n--- 11. SQL endpoint edge cases ---");

  const sqlEndpoint = "/admin/v1/projects/fake-id/sql";
  const sqlAuth = { "Content-Type": "text/plain", Authorization: "Bearer fake-key" };

  // Empty SQL
  await expectNot5xx("POST", sqlEndpoint, {
    headers: sqlAuth,
    body: "",
    label: "POST /admin/.../sql (empty body)",
  });

  // Very long SQL
  await expectNot5xx("POST", sqlEndpoint, {
    headers: sqlAuth,
    body: "SELECT " + "1+".repeat(10000) + "1",
    label: "POST /admin/.../sql (very long SQL)",
  });

  // Binary in SQL
  await expectNot5xx("POST", sqlEndpoint, {
    headers: sqlAuth,
    body: "\x00\x01\x02\x03",
    label: "POST /admin/.../sql (binary garbage)",
  });

  // SQL sent as JSON (wrong content-type for this endpoint)
  await expectNot5xx("POST", sqlEndpoint, {
    headers: { "Content-Type": "application/json", Authorization: "Bearer fake-key" },
    body: '{"sql":"SELECT 1"}',
    label: "POST /admin/.../sql (JSON body instead of text)",
  });

  // ──────────────────────────────────────────────
  // 12. Nonexistent routes
  // ──────────────────────────────────────────────
  console.log("\n--- 12. Nonexistent routes ---");

  const nonexistentPaths = [
    "/v1/nonexistent",
    "/v2/projects",
    "/api/v1/projects",
    "/admin/v1/nonexistent",
    "/auth/v2/signup",
    "/storage/v2/object/bucket/file",
    "/.env",
    "/wp-admin",
    "/robots.txt",
    "/../../../etc/passwd",
  ];

  for (const path of nonexistentPaths) {
    await expectNot5xx("GET", path, {
      label: `GET ${path} (nonexistent route)`,
      expectStatus: [404, 401, 403],
    });
  }

  // ──────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
