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
 *   8.  Verify GET /v1/deployments/:id (metadata lookup)
 *   9.  Verify idempotency (same key → same deployment)
 *   10. Verify auto subdomain reassignment on redeploy
 *
 * Usage:
 *   BASE_URL=https://api.run402.com npx tsx test/deploy-site-e2e.ts          # mainnet
 *   BASE_URL=https://api.run402.com TESTNET=1 npx tsx test/deploy-site-e2e.ts  # testnet
 */

import { config } from "dotenv";
config();

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { randomBytes } from "node:crypto";
import { ensureTestBalance } from "./ensure-balance.js";

// --- Config ---

const BUYER_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const BASE_URL = process.env.BASE_URL || "http://localhost:4022";
const USE_TESTNET = !!process.env.TESTNET;

if (!BUYER_KEY) {
  console.error("Missing BUYER_PRIVATE_KEY in .env");
  process.exit(1);
}

// --- Setup x402 client ---

const chain = USE_TESTNET ? baseSepolia : base;
const network = USE_TESTNET ? "eip155:84532" : "eip155:8453";

const account = privateKeyToAccount(BUYER_KEY);
const publicClient = createPublicClient({ chain, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register(network as `${string}:${string}`, new ExactEvmScheme(signer));
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
  await ensureTestBalance(account.address, BASE_URL);

  console.log("\n=== Deploy Site E2E Test ===\n");
  console.log(`Target:  ${BASE_URL}`);
  console.log(`Buyer:   ${account.address}\n`);

  // Test 1: Deploy a simple site
  console.log("1) Deploy a simple site...");
  const deployRes = await fetchPaid(`${BASE_URL}/v1/deployments`, {
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
  const pngDeployRes = await fetchPaid(`${BASE_URL}/v1/deployments`, {
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

  // Test 8: GET /v1/deployments/:id
  console.log("\n8) Verify GET /v1/deployments/:id...");
  const getRes = await fetch(`${BASE_URL}/v1/deployments/${deploymentId}`);
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

  const idem1 = await fetchPaid(`${BASE_URL}/v1/deployments`, {
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

  const idem2 = await fetchPaid(`${BASE_URL}/v1/deployments`, {
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

  // Test 10: Auto subdomain reassignment on redeploy
  console.log("\n10) Verify auto subdomain reassignment on redeploy...");

  // 10a: Provision a project for subdomain test
  const subTestProjectRes = await fetchPaid(`${BASE_URL}/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "e2e-subdomain-reassign" }),
  });
  const subTestProject = await subTestProjectRes.json();
  const subTestProjectId = subTestProject.id || subTestProject.project_id;
  const subTestServiceKey = subTestProject.service_key;
  assert(!!subTestProjectId, `Subdomain test project provisioned (${subTestProjectId})`);

  // 10b: Deploy first version
  const deploy1Res = await fetchPaid(`${BASE_URL}/v1/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project: subTestProjectId,
      files: [{ file: "index.html", data: "<h1>Version 1</h1>" }],
    }),
  });
  const deploy1 = await deploy1Res.json();
  assert(deploy1Res.status === 201, `First deploy returns 201 (got ${deploy1Res.status})`);
  assert(!deploy1.subdomain_urls, `First deploy has no subdomain_urls (no subdomain claimed yet)`);

  // 10c: Claim a subdomain pointing to first deployment
  const subName = `e2e-auto-${randomBytes(4).toString("hex")}`;
  const claimRes = await fetch(`${BASE_URL}/v1/subdomains`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${subTestServiceKey}`,
    },
    body: JSON.stringify({
      name: subName,
      deployment_id: deploy1.deployment_id,
    }),
  });
  assert(claimRes.status === 201 || claimRes.status === 200, `Subdomain claimed (got ${claimRes.status})`);

  // 10d: Deploy second version — should auto-reassign the subdomain
  const deploy2Res = await fetchPaid(`${BASE_URL}/v1/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project: subTestProjectId,
      files: [{ file: "index.html", data: "<h1>Version 2</h1>" }],
    }),
  });
  const deploy2 = await deploy2Res.json();
  assert(deploy2Res.status === 201, `Second deploy returns 201 (got ${deploy2Res.status})`);
  assert(
    Array.isArray(deploy2.subdomain_urls) && deploy2.subdomain_urls.includes(`https://${subName}.run402.com`),
    `Second deploy includes subdomain_urls with ${subName} (got ${JSON.stringify(deploy2.subdomain_urls)})`,
  );

  // 10e: Fetch subdomain URL — should serve version 2
  try {
    const subRes = await fetch(`https://${subName}.run402.com`);
    const subBody = await subRes.text();
    assert(subRes.ok, `Subdomain serves 200 (got ${subRes.status})`);
    assert(subBody.includes("Version 2"), `Subdomain serves Version 2 content`);
  } catch (err: any) {
    assert(false, `Failed to fetch subdomain: ${err.message}`);
  }

  // 10f: Old deployment URL should still serve version 1 (immutability)
  try {
    const oldRes = await fetch(deploy1.url);
    const oldBody = await oldRes.text();
    assert(oldRes.ok, `Old deployment URL still serves 200`);
    assert(oldBody.includes("Version 1"), `Old deployment URL still serves Version 1`);
  } catch (err: any) {
    assert(false, `Failed to fetch old deployment: ${err.message}`);
  }

  // 10g: Cleanup — delete subdomain
  await fetch(`${BASE_URL}/v1/subdomains/${subName}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${subTestServiceKey}` },
  });

  // --- Summary ---
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
