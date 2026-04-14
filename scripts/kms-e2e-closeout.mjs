// End-to-end closeout runner for kms-wallet-contracts openspec change.
// 1) Subscribe showcase wallet to prototype tier via x402
// 2) Create run402 project
// 3) Print service_key for contracts-e2e

import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const API = "https://api.run402.com";
const pk = readFileSync("c:/Workspace-Kychee/bld402/showcase/.wallet","utf-8").trim();
const account = privateKeyToAccount(pk);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register("eip155:84532", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

async function siwxHeader(uri, statement) {
  const p = await createSIWxPayload({
    domain: "api.run402.com", uri, statement, version: "1",
    nonce: randomBytes(16).toString("hex"),
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 5*60*1000).toISOString(),
    chainId: "eip155:84532", type: "eip191",
  }, account);
  return encodeSIWxHeader(p);
}

console.log("Wallet:", account.address);

// 1) tier subscribe via x402
console.log("\n[1] POST /tiers/v1/prototype (x402)");
let r = await fetchPaid(`${API}/tiers/v1/prototype`, { method: "POST" });
console.log("  status:", r.status);
console.log("  body:", (await r.text()).slice(0, 200));

// 2) create project via SIWX
console.log("\n[2] POST /projects/v1 (SIWX)");
const h = await siwxHeader(`${API}/projects/v1`, "Create kms-e2e-closeout project");
r = await fetch(`${API}/projects/v1`, {
  method: "POST",
  headers: { "content-type": "application/json", "SIGN-IN-WITH-X": h },
  body: JSON.stringify({ name: "kms-e2e-closeout" }),
});
console.log("  status:", r.status);
const body = await r.json();
console.log("  project_id:", body.project_id);
console.log("  service_key:", body.service_key ? body.service_key.slice(0,20)+"..." : "none");

if (body.service_key) {
  console.log("\nExport these for contracts-e2e:");
  console.log(`  export BASE_URL=${API}`);
  console.log(`  export E2E_PROJECT_API_KEY=${body.service_key}`);
  console.log(`  export E2E_PROJECT_ID=${body.project_id}`);
}
