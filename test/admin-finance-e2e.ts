/**
 * Admin Finance Dashboard E2E Test
 *
 * Hits a running gateway and exercises the new /admin/finance surfaces:
 *   1. GET /admin/finance (unauthenticated) → 302 redirect to /admin/login
 *   2. GET /admin/finance (authed) → 200 with HTML containing "Finance"
 *   3. GET /admin/api/finance/summary?window=30d → 200 with JSON shape
 *   4. GET /admin/api/finance/revenue → 200 with projects array
 *   5. GET /admin/api/finance/costs → 200 with categories + reconciliation
 *   6. GET /admin/api/finance/export?scope=platform&window=30d&format=csv → 200 CSV
 *   7. Invalid window → 400
 *   8. Invalid format → 400
 *   9. Backward-compat: /admin/projects and /admin/subdomains still return 200
 *
 * Session cookies are forged in-test using ADMIN_SESSION_SECRET (same HMAC
 * pattern as the live gateway's admin-dashboard.ts).
 *
 * Usage:
 *   BASE_URL=http://localhost:4022 ADMIN_SESSION_SECRET=... npm run test:admin-finance
 *   BASE_URL=https://api.run402.com ADMIN_SESSION_SECRET=... npm run test:admin-finance
 */

import { config } from "dotenv";
config();

import crypto from "node:crypto";

const BASE_URL = process.env.BASE_URL || "http://localhost:4022";
const SECRET = process.env.ADMIN_SESSION_SECRET;

if (!SECRET) {
  console.error("ADMIN_SESSION_SECRET not set in env — cannot forge admin session cookie.");
  process.exit(1);
}

const SESSION_COOKIE = "run402_admin";

function forgeAdminSession(email: string, name: string): string {
  const payload = JSON.stringify({ email, name, exp: Date.now() + 3600_000 });
  const b64 = Buffer.from(payload).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET as string).update(b64).digest("hex");
  return `${b64}.${sig}`;
}

const adminCookie = `${SESSION_COOKIE}=${forgeAdminSession("e2e-admin@kychee.com", "E2E Admin")}`;

// --- Tiny test runner ------------------------------------------------------

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail });
    console.log(`  ✗ ${name}`);
    console.log(`    ${detail}`);
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
}

// --- Tests -----------------------------------------------------------------

async function run() {
  console.log(`\nAdmin Finance E2E — BASE_URL=${BASE_URL}\n`);

  await test("1. GET /admin/finance (unauthenticated) → 302 redirect", async () => {
    const res = await fetch(`${BASE_URL}/admin/finance`, { redirect: "manual" });
    assertEq(res.status, 302, "status");
    const location = res.headers.get("location") || "";
    assertTrue(location.includes("/admin/login"), `redirect location: ${location}`);
  });

  await test("2. GET /admin/finance (authed) → 200 with Finance in HTML", async () => {
    const res = await fetch(`${BASE_URL}/admin/finance`, {
      headers: { cookie: adminCookie },
    });
    assertEq(res.status, 200, "status");
    const text = await res.text();
    assertTrue(text.includes("Finance"), "HTML should contain 'Finance'");
    assertTrue(text.includes("kpi-revenue"), "HTML should contain kpi-revenue id");
  });

  await test("3. GET /admin/api/finance/summary?window=30d → 200 with JSON shape", async () => {
    const res = await fetch(`${BASE_URL}/admin/api/finance/summary?window=30d`, {
      headers: { cookie: adminCookie },
    });
    assertEq(res.status, 200, "status");
    const body = await res.json() as Record<string, unknown>;
    assertTrue("revenue_usd_micros" in body, "missing revenue_usd_micros");
    assertTrue("cost_usd_micros" in body, "missing cost_usd_micros");
    assertTrue("margin_usd_micros" in body, "missing margin_usd_micros");
    assertTrue("cost_source" in body, "missing cost_source");
    assertEq((body as { window: string }).window, "30d", "window");
  });

  await test("4. GET /admin/api/finance/revenue → 200 with projects array", async () => {
    const res = await fetch(`${BASE_URL}/admin/api/finance/revenue?window=30d`, {
      headers: { cookie: adminCookie },
    });
    assertEq(res.status, 200, "status");
    const body = await res.json() as { projects: unknown[]; total_usd_micros: number };
    assertTrue(Array.isArray(body.projects), "projects should be an array");
    assertTrue(typeof body.total_usd_micros === "number", "total_usd_micros should be a number");
  });

  await test("5. GET /admin/api/finance/costs → 200 with categories + reconciliation", async () => {
    const res = await fetch(`${BASE_URL}/admin/api/finance/costs?window=30d`, {
      headers: { cookie: adminCookie },
    });
    assertEq(res.status, 200, "status");
    const body = await res.json() as { categories: unknown[]; reconciliation: unknown };
    assertTrue(Array.isArray(body.categories), "categories should be an array");
    assertTrue("reconciliation" in body, "missing reconciliation");
  });

  await test("6. GET /admin/api/finance/export?scope=platform → CSV download", async () => {
    const res = await fetch(`${BASE_URL}/admin/api/finance/export?scope=platform&window=30d&format=csv`, {
      headers: { cookie: adminCookie },
    });
    assertEq(res.status, 200, "status");
    const contentType = res.headers.get("content-type") || "";
    assertTrue(contentType.startsWith("text/csv"), `Content-Type: ${contentType}`);
    const text = await res.text();
    assertTrue(text.includes("# Platform Summary"), "CSV should have Platform Summary section");
    assertTrue(text.includes("# Revenue Breakdown by Project"), "CSV should have Revenue Breakdown section");
    assertTrue(text.includes("# Cost Breakdown by Category"), "CSV should have Cost Breakdown section");
  });

  await test("7. GET /admin/api/finance/summary?window=1y → 400 invalid_window", async () => {
    const res = await fetch(`${BASE_URL}/admin/api/finance/summary?window=1y`, {
      headers: { cookie: adminCookie },
    });
    assertEq(res.status, 400, "status");
    const body = await res.json() as { error: string };
    assertEq(body.error, "invalid_window", "error code");
  });

  await test("8. GET /admin/api/finance/export?format=json → 400 unsupported_format", async () => {
    const res = await fetch(`${BASE_URL}/admin/api/finance/export?scope=platform&window=30d&format=json`, {
      headers: { cookie: adminCookie },
    });
    assertEq(res.status, 400, "status");
    const body = await res.json() as { error: string };
    assertEq(body.error, "unsupported_format", "error code");
  });

  await test("9a. Backward-compat: /admin/projects still returns 200", async () => {
    const res = await fetch(`${BASE_URL}/admin/projects`, {
      headers: { cookie: adminCookie },
    });
    assertEq(res.status, 200, "status");
    const text = await res.text();
    assertTrue(text.includes("Projects"), "should still render projects page");
  });

  await test("9b. Backward-compat: /admin/subdomains still returns 200", async () => {
    const res = await fetch(`${BASE_URL}/admin/subdomains`, {
      headers: { cookie: adminCookie },
    });
    assertEq(res.status, 200, "status");
  });

  await test("9c. Backward-compat: /admin/api/stats still returns 200", async () => {
    const res = await fetch(`${BASE_URL}/admin/api/stats`, {
      headers: { cookie: adminCookie },
    });
    assertEq(res.status, 200, "status");
  });

  // --- Summary ---
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("E2E runner crashed:", err);
  process.exit(1);
});
