import { config } from "dotenv"; config();
import { readFileSync, writeFileSync } from "fs";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";

const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`);
const pub = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, pub);
const client = new x402Client();
client.register("eip155:84532", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);
const BASE = "https://api.run402.com";

async function siwx(uri: string) {
  const info = { domain: "api.run402.com", uri, statement: "Sign in to Run402", version: "1", nonce: crypto.randomUUID().replace(/-/g, ""), issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + 300000).toISOString(), chainId: "eip155:84532", type: "eip191" as const };
  const payload = await createSIWxPayload(info, account);
  return { "SIGN-IN-WITH-X": encodeSIWxHeader(payload) };
}

async function main() {
  const html = readFileSync(new URL("../../remotion/out/claude-code-preview.html", import.meta.url), "utf-8");

  console.log("Subscribing...");
  await fetchPaid(BASE + "/tiers/v1/prototype", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

  console.log("Provisioning...");
  const h1 = await siwx(BASE + "/projects/v1");
  const r1 = await fetch(BASE + "/projects/v1", { method: "POST", headers: { "Content-Type": "application/json", ...h1 }, body: JSON.stringify({ name: "coinbase-demo" }) });
  const proj = await r1.json();
  console.log("Project:", proj.project_id);

  writeFileSync(new URL("./coinbase-state.json", import.meta.url), JSON.stringify({ project_id: proj.project_id, service_key: proj.service_key }, null, 2));
  console.log("Keys saved to coinbase-state.json");

  console.log("Deploying...");
  const h2 = await siwx(BASE + "/deployments/v1");
  const r2 = await fetch(BASE + "/deployments/v1", { method: "POST", headers: { "Content-Type": "application/json", ...h2 }, body: JSON.stringify({ project: proj.project_id, files: [{ file: "index.html", data: html }] }) });
  const site = await r2.json();
  console.log("Site:", site.url);

  console.log("Claiming coinbase.run402.com...");
  const r3 = await fetch(BASE + "/subdomains/v1", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + proj.service_key }, body: JSON.stringify({ name: "coinbase", deployment_id: site.deployment_id }) });
  console.log("Subdomain:", await r3.json());

  await fetch(BASE + "/projects/v1/admin/" + proj.project_id + "/pin", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + proj.service_key, "X-Admin-Key": process.env.ADMIN_KEY! } });
  console.log("Pinned. LIVE: https://coinbase.run402.com");
}

main().catch(e => { console.error(e); process.exit(1); });
