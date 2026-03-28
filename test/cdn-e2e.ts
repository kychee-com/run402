/**
 * CDN E2E Test — verifies CloudFront edge caching for custom subdomains.
 *
 * Tests:
 *   9.1 Asset served from CloudFront with immutable cache
 *   9.2 HTML served through ALB with max-age=60
 *   9.3 Redeploy → CloudFront invalidation → new content served
 *   9.4 KVS entry exists (inferred from 9.1)
 *   9.5 Delete subdomain → asset returns non-200
 *
 * Usage: BASE_URL=https://api.run402.com npx tsx test/cdn-e2e.ts
 */

import { config } from "dotenv";
config();

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import type { CompleteSIWxInfo } from "@x402/extensions/sign-in-with-x";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const BASE_URL = process.env.BASE_URL || "http://localhost:4022";
const BUYER_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
if (!BUYER_KEY) { console.error("Missing BUYER_PRIVATE_KEY"); process.exit(1); }

const account = privateKeyToAccount(BUYER_KEY);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register("eip155:84532", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

async function siwxHeaders(path: string): Promise<Record<string, string>> {
  const baseUrl = new URL(BASE_URL);
  const now = new Date();
  const info: CompleteSIWxInfo = {
    domain: baseUrl.hostname,
    uri: `${baseUrl.protocol}//${baseUrl.host}${path}`,
    statement: "Sign in to Run402",
    version: "1",
    nonce: Math.random().toString(36).slice(2),
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    chainId: "eip155:84532",
    type: "eip191",
  };
  const payload = await createSIWxPayload(info, account);
  return { "SIGN-IN-WITH-X": encodeSIWxHeader(payload) };
}

let passed = 0;
let failed = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { passed++; console.log(`  PASS: ${msg}`); }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

/** Poll until condition is true or max attempts reached. Returns last response. */
async function poll(
  url: string,
  check: (res: Response, body: string) => boolean,
  { maxAttempts = 30, intervalMs = 1000, label = "" } = {},
): Promise<{ res: Response; body: string; attempts: number }> {
  let res!: Response;
  let body = "";
  for (let i = 1; i <= maxAttempts; i++) {
    res = await fetch(url);
    body = await res.text();
    if (check(res, body)) return { res, body, attempts: i };
    if (i < maxAttempts) await new Promise(r => setTimeout(r, intervalMs));
  }
  if (label) console.log(`    (polled ${maxAttempts} times for: ${label})`);
  return { res, body, attempts: maxAttempts };
}

async function main() {
  console.log(`\nCDN E2E Test — ${BASE_URL}\n`);

  // --- Setup: subscribe + create project ---
  console.log("Setup: subscribe + create project");
  const tierRes = await fetchPaid(`${BASE_URL}/tiers/v1/prototype`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  console.log(`  Tier: ${tierRes.status}`);

  const projH = await siwxHeaders("/projects/v1");
  const projRes = await fetch(`${BASE_URL}/projects/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...projH },
    body: JSON.stringify({ name: `cdn-test-${Date.now()}` }),
  });
  const proj = (await projRes.json()) as Record<string, string>;
  assert(projRes.status === 201, `Project created: ${proj.project_id}`);
  const sk = proj.service_key;
  const auth = { Authorization: `Bearer ${sk}`, "Content-Type": "application/json" };
  const subName = `cdn-${Date.now().toString(36)}`;
  const subUrl = `https://${subName}.run402.com`;

  try {
    // --- Deploy site v1 with HTML + CSS ---
    console.log("\nDeploy v1");
    const deploy1H = await siwxHeaders("/deployments/v1");
    const deploy1Res = await fetch(`${BASE_URL}/deployments/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deploy1H },
      body: JSON.stringify({
        project: proj.project_id,
        files: [
          { file: "index.html", data: "<html><head><link rel='stylesheet' href='style.css'></head><body><h1>v1</h1></body></html>" },
          { file: "style.css", data: "body { background: blue; }" },
        ],
      }),
    });
    const deploy1 = (await deploy1Res.json()) as Record<string, string>;
    assert(deploy1Res.status === 201, `Deploy v1: ${deploy1.deployment_id}`);

    // --- Claim subdomain ---
    console.log("\nClaim subdomain");
    const claimRes = await fetch(`${BASE_URL}/subdomains/v1`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: subName, deployment_id: deploy1.deployment_id }),
    });
    const claimBody = (await claimRes.json()) as Record<string, unknown>;
    assert(claimRes.status === 201, `Subdomain claimed: ${claimBody.name} (${claimRes.status})`);

    if (claimRes.status !== 201) {
      console.error("  Claim response:", JSON.stringify(claimBody));
      console.log("\n=== Aborting — subdomain claim failed ===");
      return;
    }

    // --- 9.1: Asset via CloudFront with immutable cache ---
    console.log("\n9.1: Asset cache headers");
    const { res: cssRes, body: cssBody, attempts: a1 } = await poll(
      `${subUrl}/style.css`,
      (r) => r.status === 200,
      { maxAttempts: 60, label: "KVS propagation" },
    );
    const cssH = Object.fromEntries(cssRes.headers.entries());
    console.log(`  Status: ${cssRes.status} (after ${a1} poll${a1 > 1 ? "s" : ""})`);
    console.log(`  Cache-Control: ${cssH["cache-control"] || "(none)"}`);
    console.log(`  x-cache: ${cssH["x-cache"] || "(none)"}`);
    console.log(`  Content: ${cssBody.substring(0, 40)}`);
    assert(cssRes.status === 200, "Asset returns 200");
    assert(cssH["cache-control"]?.includes("immutable") === true, "Asset has immutable cache");
    assert(cssH["via"]?.includes("cloudfront") === true, "Asset served via CloudFront");

    // --- 9.2: HTML via gateway ---
    console.log("\n9.2: HTML cache headers");
    const htmlRes = await fetch(`${subUrl}/`);
    const htmlH = Object.fromEntries(htmlRes.headers.entries());
    assert(htmlRes.status === 200, "HTML returns 200");
    assert(htmlH["cache-control"]?.includes("max-age=60") === true, "HTML has max-age=60");
    assert(htmlH["x-powered-by"] === "Express", "HTML served by Express (ALB)");

    // --- 9.3: Redeploy → invalidation → new content ---
    console.log("\n9.3: Redeploy freshness");
    const deploy2H = await siwxHeaders("/deployments/v1");
    const deploy2Res = await fetch(`${BASE_URL}/deployments/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deploy2H },
      body: JSON.stringify({
        project: proj.project_id,
        files: [
          { file: "index.html", data: "<html><body><h1>v2</h1></body></html>" },
          { file: "style.css", data: "body { background: red; }" },
        ],
      }),
    });
    const deploy2 = (await deploy2Res.json()) as Record<string, string>;
    assert(deploy2Res.status === 201, `Deploy v2: ${deploy2.deployment_id}`);

    // Reassign subdomain (triggers KVS update + CloudFront invalidation)
    const reassignRes = await fetch(`${BASE_URL}/subdomains/v1`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: subName, deployment_id: deploy2.deployment_id }),
    });
    assert(reassignRes.status === 201, `Subdomain reassigned (${reassignRes.status})`);

    // Poll until new content appears (invalidation propagation ~5-15s)
    const { body: css2Body, attempts: a3 } = await poll(
      `${subUrl}/style.css`,
      (_r, body) => body.includes("background: red"),
      { maxAttempts: 60, label: "invalidation propagation" },
    );
    console.log(`  New CSS: ${css2Body.substring(0, 40)} (after ${a3} poll${a3 > 1 ? "s" : ""})`);
    assert(css2Body.includes("red"), "New CSS content served after redeploy");

    // --- 9.4: KVS entry (inferred from 9.1) ---
    console.log("\n9.4: KVS entry exists");
    assert(cssRes.status === 200, "KVS resolved subdomain (inferred from 9.1)");

    // --- 9.5: Delete subdomain ---
    console.log("\n9.5: Delete subdomain");
    await fetch(`${BASE_URL}/subdomains/v1/${subName}`, {
      method: "DELETE",
      headers: auth,
    });
    // Poll until non-200 (KVS propagation + possible cache expiry)
    const { res: delRes, attempts: a5 } = await poll(
      `${subUrl}/style.css`,
      (r) => r.status !== 200,
      { maxAttempts: 60, label: "KVS delete propagation" },
    );
    console.log(`  Status: ${delRes.status} (after ${a5} poll${a5 > 1 ? "s" : ""})`);
    assert(delRes.status !== 200, "Asset unavailable after subdomain delete");

  } finally {
    // --- Cleanup ---
    console.log("\nCleanup");
    // Delete subdomain if still exists
    await fetch(`${BASE_URL}/subdomains/v1/${subName}`, {
      method: "DELETE",
      headers: auth,
    });
    const delH = await siwxHeaders(`/projects/v1/${proj.project_id}`);
    await fetch(`${BASE_URL}/projects/v1/${proj.project_id}`, {
      method: "DELETE",
      headers: { ...delH },
    });
    console.log("  Project deleted");
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
