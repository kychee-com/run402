/**
 * Deploy Site E2E Test — Static Site Deployment Lifecycle
 *
 * Tests the full deployment lifecycle against a running AgentDB instance:
 *   1.  Deploy a simple site (index.html + style.css + assets/app.js)
 *   2.  Verify response (id, url, status, files_count, total_size)
 *   3.  Fetch the live site (index.html via deployment URL)
 *   4.  Verify static assets (style.css, assets/app.js with correct Content-Type)
 *   5.  Verify SPA fallback (/about returns index.html with 200)
 *   6.  Verify actual 404 (/nonexistent.js returns 403/404)
 *   7.  Deploy with base64 file (PNG), verify Content-Type
 *   8.  Verify GET /v13/deployments/:id (metadata lookup)
 *   9.  Verify idempotency (same key → same deployment)
 *
 * Usage:
 *   BASE_URL=http://localhost:4022 npx tsx test/deploy-site-e2e.ts
 *   BASE_URL=https://api.run402.com npx tsx test/deploy-site-e2e.ts
 */

import { config } from "dotenv";
config();

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { randomBytes } from "node:crypto";

// --- Config ---

const BUYER_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const BASE_URL = process.env.BASE_URL || "http://localhost:4022";

if (!BUYER_KEY) {
  console.error("Missing BUYER_PRIVATE_KEY in .env");
  process.exit(1);
}

// --- Setup x402 client ---

const account = privateKeyToAccount(BUYER_KEY);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

// --- Helpers ---

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

// 1x1 transparent PNG (smallest valid PNG)
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// --- Main test flow ---

async function main() {
  console.log("\n=== Deploy Site E2E Test ===\n");
  console.log(`Target:  ${BASE_URL}`);
  console.log(`Buyer:   ${account.address}\n`);

  // Test 1: Deploy a simple site
  console.log("1) Deploy a simple site...");
  const deployRes = await fetchPaid(`${BASE_URL}/v13/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "e2e-test-site",
      target: "production",
      files: [
        {
          file: "index.html",
          data: "<!DOCTYPE html><html><head><link rel='stylesheet' href='/style.css'></head><body><h1>Hello from E2E</h1><script src='/assets/app.js'></script></body></html>",
        },
        {
          file: "style.css",
          data: "body { font-family: sans-serif; margin: 0; padding: 20px; }",
        },
        {
          file: "assets/app.js",
          data: "console.log('E2E test app loaded');",
        },
      ],
    }),
  });

  const deployment = await deployRes.json();

  // Test 2: Verify response
  console.log("\n2) Verify deployment response...");
  assert(deployRes.status === 201, `Status is 201 (got ${deployRes.status})`);
  assert(typeof deployment.id === "string" && deployment.id.startsWith("dpl_"), `ID starts with dpl_ (${deployment.id})`);
  assert(typeof deployment.url === "string" && deployment.url.includes(".sites.run402.com"), `URL contains .sites.run402.com`);
  assert(deployment.status === "READY", `Status is READY`);
  assert(deployment.files_count === 3, `files_count is 3 (got ${deployment.files_count})`);
  assert(deployment.total_size > 0, `total_size > 0 (got ${deployment.total_size})`);
  assert(deployment.name === "e2e-test-site", `name matches`);

  const deploymentUrl = deployment.url;
  const deploymentId = deployment.id;

  // Test 3: Fetch the live site
  console.log("\n3) Fetch the live site...");
  try {
    const siteRes = await fetch(deploymentUrl);
    const siteBody = await siteRes.text();
    assert(siteRes.ok, `Site returns 200 (got ${siteRes.status})`);
    assert(siteBody.includes("Hello from E2E"), `index.html content served`);
    const contentType = siteRes.headers.get("content-type") || "";
    assert(contentType.includes("text/html"), `Content-Type is text/html (got ${contentType})`);
  } catch (err: any) {
    assert(false, `Failed to fetch site: ${err.message}`);
  }

  // Test 4: Verify static assets
  console.log("\n4) Verify static assets...");
  try {
    const cssRes = await fetch(`${deploymentUrl}/style.css`);
    const cssBody = await cssRes.text();
    assert(cssRes.ok, `style.css returns 200`);
    assert(cssBody.includes("font-family"), `style.css content correct`);
    const cssType = cssRes.headers.get("content-type") || "";
    assert(cssType.includes("text/css"), `style.css Content-Type is text/css (got ${cssType})`);

    const jsRes = await fetch(`${deploymentUrl}/assets/app.js`);
    const jsBody = await jsRes.text();
    assert(jsRes.ok, `assets/app.js returns 200`);
    assert(jsBody.includes("E2E test app loaded"), `app.js content correct`);
    const jsType = jsRes.headers.get("content-type") || "";
    assert(jsType.includes("javascript"), `app.js Content-Type includes javascript (got ${jsType})`);
  } catch (err: any) {
    assert(false, `Failed to fetch assets: ${err.message}`);
  }

  // Test 5: SPA fallback
  console.log("\n5) Verify SPA fallback...");
  try {
    const spaRes = await fetch(`${deploymentUrl}/about`);
    const spaBody = await spaRes.text();
    assert(spaRes.ok, `SPA /about returns 200 (got ${spaRes.status})`);
    assert(spaBody.includes("Hello from E2E"), `/about serves index.html content`);
  } catch (err: any) {
    assert(false, `SPA fallback failed: ${err.message}`);
  }

  // Test 6: Actual 404 for missing file with extension
  console.log("\n6) Verify 404 for missing file with extension...");
  try {
    const notFoundRes = await fetch(`${deploymentUrl}/nonexistent.js`);
    assert(
      notFoundRes.status === 403 || notFoundRes.status === 404,
      `/nonexistent.js returns 403 or 404 (got ${notFoundRes.status})`,
    );
  } catch (err: any) {
    assert(false, `404 check failed: ${err.message}`);
  }

  // Test 7: Deploy with base64 file
  console.log("\n7) Deploy with base64 PNG...");
  const pngDeployRes = await fetchPaid(`${BASE_URL}/v13/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "e2e-png-test",
      files: [
        { file: "index.html", data: "<html><body><img src='/logo.png'></body></html>" },
        { file: "logo.png", data: TINY_PNG_BASE64, encoding: "base64" },
      ],
    }),
  });

  const pngDeployment = await pngDeployRes.json();
  assert(pngDeployRes.status === 201, `PNG deployment returns 201 (got ${pngDeployRes.status})`);

  try {
    const pngRes = await fetch(`${pngDeployment.url}/logo.png`);
    assert(pngRes.ok, `PNG file returns 200`);
    const pngType = pngRes.headers.get("content-type") || "";
    assert(pngType.includes("image/png"), `PNG Content-Type is image/png (got ${pngType})`);
  } catch (err: any) {
    assert(false, `PNG fetch failed: ${err.message}`);
  }

  // Test 8: GET /v13/deployments/:id
  console.log("\n8) Verify GET /v13/deployments/:id...");
  const getRes = await fetch(`${BASE_URL}/v13/deployments/${deploymentId}`);
  const getMeta = await getRes.json();
  assert(getRes.ok, `GET deployment returns 200`);
  assert(getMeta.id === deploymentId, `ID matches`);
  assert(getMeta.name === "e2e-test-site", `name matches`);
  assert(getMeta.url === deploymentUrl, `url matches`);
  assert(getMeta.status === "READY", `status is READY`);
  assert(getMeta.files_count === 3, `files_count matches`);

  // Test 9: Idempotency
  console.log("\n9) Verify idempotency...");
  const idempotencyKey = randomBytes(16).toString("hex");

  const idem1 = await fetchPaid(`${BASE_URL}/v13/deployments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      name: "e2e-idempotency-test",
      files: [{ file: "index.html", data: "<h1>Idempotency</h1>" }],
    }),
  });
  const idemBody1 = await idem1.json();
  assert(idem1.status === 201, `First idempotent deploy returns 201`);

  const idem2 = await fetchPaid(`${BASE_URL}/v13/deployments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      name: "e2e-idempotency-test",
      files: [{ file: "index.html", data: "<h1>Idempotency</h1>" }],
    }),
  });
  const idemBody2 = await idem2.json();
  assert(idemBody2.id === idemBody1.id, `Same Idempotency-Key returns same deployment ID`);

  // --- Summary ---
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
