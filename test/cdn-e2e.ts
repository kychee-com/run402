import { config } from "dotenv";
config();
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const BASE_URL = "https://api.run402.com";
const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register("eip155:84532", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

async function siwxHeaders(path: string) {
  const baseUrl = new URL(BASE_URL);
  const now = new Date();
  const payload = await createSIWxPayload({
    domain: baseUrl.hostname,
    uri: `${baseUrl.protocol}//${baseUrl.host}${path}`,
    statement: "Sign in to Run402",
    version: "1",
    nonce: Math.random().toString(36).slice(2),
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 5*60*1000).toISOString(),
    chainId: "eip155:84532",
    type: "eip191",
  }, account);
  return { "SIGN-IN-WITH-X": encodeSIWxHeader(payload) };
}

async function main() {
  console.log("CDN E2E Test\n");

  // Deploy site with HTML + CSS + JS
  const projH = await siwxHeaders("/projects/v1");
  const projRes = await fetch(`${BASE_URL}/projects/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...projH },
    body: JSON.stringify({ name: `cdn-test-${Date.now()}` }),
  });
  const proj = await projRes.json() as any;
  console.log(`Project: ${proj.project_id}`);
  const sk = proj.service_key;

  const siteH = await siwxHeaders("/deployments/v1");
  const siteRes = await fetch(`${BASE_URL}/deployments/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...siteH },
    body: JSON.stringify({
      project: proj.project_id,
      files: [
        { file: "index.html", data: "<html><head><link rel='stylesheet' href='style.css'></head><body><h1>CDN Test v1</h1><script src='app.js'></script></body></html>" },
        { file: "style.css", data: "body { background: blue; color: white; }" },
        { file: "app.js", data: "console.log('v1');" },
        { file: "logo.png", data: btoa("fakepng"), encoding: "base64" },
      ],
    }),
  });
  const site = await siteRes.json() as any;
  console.log(`Deploy 1: ${site.deployment_id}`);

  // Claim subdomain
  const subRes = await fetch(`${BASE_URL}/subdomains/v1`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sk}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "cdn-test", deployment_id: site.deployment_id }),
  });
  console.log(`Subdomain: ${(await subRes.json() as any).name}`);

  // Poll for KVS propagation — asset returns 200 once KVS has the entry
  console.log("Polling for KVS propagation...");
  let cssRes: Response | null = null;
  for (let attempt = 1; attempt <= 30; attempt++) {
    cssRes = await fetch("https://cdn-test.run402.com/style.css");
    if (cssRes.status === 200) break;
    await cssRes.text(); // drain body
    if (attempt < 30) await new Promise(r => setTimeout(r, 1000));
  }

  // Test 9.1: Asset via CloudFront with immutable cache
  console.log("\n--- 9.1: Asset cache headers ---");
  const cssHeaders = Object.fromEntries(cssRes!.headers.entries());
  const cssText = await cssRes!.text();
  console.log(`  Status: ${cssRes!.status}`);
  console.log(`  Cache-Control: ${cssHeaders["cache-control"] || "(none)"}`);
  console.log(`  x-cache: ${cssHeaders["x-cache"] || "(none)"}`);
  console.log(`  via: ${cssHeaders["via"] || "(none)"}`);
  console.log(`  Content: ${cssText.substring(0, 50)}`);
  const asset91 = cssRes!.status === 200
    && cssHeaders["cache-control"]?.includes("immutable")
    && cssHeaders["via"]?.includes("cloudfront");
  console.log(`  RESULT: ${asset91 ? "PASS" : "FAIL"}`);

  // Test 9.2: HTML via gateway with max-age=60
  console.log("\n--- 9.2: HTML cache headers ---");
  const htmlRes = await fetch("https://cdn-test.run402.com/");
  const htmlHeaders = Object.fromEntries(htmlRes.headers.entries());
  console.log(`  Status: ${htmlRes.status}`);
  console.log(`  Cache-Control: ${htmlHeaders["cache-control"] || "(none)"}`);
  console.log(`  x-powered-by: ${htmlHeaders["x-powered-by"] || "(none)"}`);
  const html92 = htmlRes.status === 200 && htmlHeaders["cache-control"]?.includes("max-age=60");
  console.log(`  RESULT: ${html92 ? "PASS" : "FAIL"}`);

  // Test 9.3: Redeploy, fetch same asset URL → new content
  console.log("\n--- 9.3: Redeploy freshness ---");
  const siteH2 = await siwxHeaders("/deployments/v1");
  const site2Res = await fetch(`${BASE_URL}/deployments/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...siteH2 },
    body: JSON.stringify({
      project: proj.project_id,
      files: [
        { file: "index.html", data: "<html><head><link rel='stylesheet' href='style.css'></head><body><h1>CDN Test v2</h1></body></html>" },
        { file: "style.css", data: "body { background: red; color: white; }" },
      ],
    }),
  });
  const site2 = await site2Res.json() as any;
  console.log(`  Deploy 2: ${site2.deployment_id}`);

  // Reassign subdomain
  await fetch(`${BASE_URL}/subdomains/v1`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sk}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "cdn-test", deployment_id: site2.deployment_id }),
  });
  // Poll until new CSS content appears (KVS propagation + 60s edge cache expiry)
  let css2Text = "";
  let css2Attempts = 0;
  for (let attempt = 1; attempt <= 90; attempt++) {
    css2Attempts = attempt;
    const r = await fetch("https://cdn-test.run402.com/style.css");
    css2Text = await r.text();
    if (css2Text.includes("red")) break;
    if (attempt < 90) await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`  Polled ${css2Attempts} times`);
  console.log(`  New CSS content: ${css2Text.substring(0, 50)}`);
  const fresh93 = css2Text.includes("red");
  console.log(`  RESULT: ${fresh93 ? "PASS" : "FAIL"}`);

  // Test 9.4: KVS entry exists
  console.log("\n--- 9.4: KVS entry exists ---");
  // Inferred from successful asset fetch — KVS resolved subdomain to deployment
  console.log(`  RESULT: ${asset91 ? "PASS (inferred from 9.1)" : "FAIL"}`);

  // Test 9.5: Delete subdomain, KVS entry removed
  console.log("\n--- 9.5: Delete subdomain ---");
  await fetch(`${BASE_URL}/subdomains/v1/cdn-test`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${sk}` },
  });
  // Poll until asset returns non-200 (KVS entry removed + 60s edge cache expiry)
  let delStatus = 200;
  for (let attempt = 1; attempt <= 90; attempt++) {
    const r = await fetch("https://cdn-test.run402.com/style.css");
    delStatus = r.status;
    await r.text();
    if (delStatus !== 200) break;
    if (attempt < 90) await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`  Status after delete: ${delStatus}`);
  const del95 = delStatus === 404 || delStatus === 502 || delStatus === 503;
  console.log(`  RESULT: ${del95 ? "PASS" : "FAIL"}`);

  // Cleanup
  console.log("\n--- Cleanup ---");
  const delH = await siwxHeaders(`/projects/v1/${proj.project_id}`);
  await fetch(`${BASE_URL}/projects/v1/${proj.project_id}`, {
    method: "DELETE",
    headers: { ...delH },
  });
  console.log("  Project deleted");

  console.log(`\n=== Results: ${[asset91,html92,fresh93,del95].filter(Boolean).length}/4 passed ===`);
}

main().catch(console.error);
