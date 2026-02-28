/**
 * OpenClaw Bootstrap E2E Test
 *
 * Simulates a brand-new OpenClaw agent that reads the docs, funds itself,
 * provisions a database, uses it, and cleans up — entirely autonomously.
 * No env vars needed (generates its own wallet).
 *
 * Usage:
 *   npm run test:openclaw
 *   BASE_URL=http://localhost:4022 npm run test:openclaw
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";

// --- Config ---

const BASE_URL = process.env.BASE_URL || "https://api.run402.com";
const DOCS_URL = "https://run402.com/llms.txt";
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const USDC_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
]);

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

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Main test flow ---

async function main() {
  console.log("\n=== OpenClaw Bootstrap E2E Test ===\n");
  console.log(`Target: ${BASE_URL}\n`);

  // Step 1: Read the docs
  console.log("1) Read the docs...");
  const docsRes = await fetch(DOCS_URL);
  const docsBody = await docsRes.text();
  assert(docsRes.ok, "llms.txt returns 200");
  assert(docsBody.includes("POST /v1/faucet"), "Docs mention POST /v1/faucet");
  assert(docsBody.includes("POST /v1/projects"), "Docs mention POST /v1/projects");

  // Step 2: Generate wallet
  console.log("\n2) Generate wallet...");
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  console.log(`  Wallet: ${account.address}`);
  assert(account.address.startsWith("0x"), "Generated valid address");

  // Step 3: Get a drip
  console.log("\n3) Get a drip from faucet...");
  const faucetRes = await fetch(`${BASE_URL}/v1/faucet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  });
  const faucetBody = await faucetRes.json();
  assert(faucetRes.ok, `Faucet returns 200 (status ${faucetRes.status})`);
  assert(typeof faucetBody.transactionHash === "string", "Faucet returns transactionHash");
  console.log(`  TX: ${faucetBody.transactionHash}`);

  // Step 4: Wait for USDC balance
  console.log("\n4) Wait for USDC balance...");
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
  const TARGET_BALANCE = BigInt(250_000); // 0.25 USDC (6 decimals)
  const POLL_INTERVAL = 3_000;
  const TIMEOUT = 60_000;
  const start = Date.now();
  let balance = BigInt(0);

  while (Date.now() - start < TIMEOUT) {
    balance = await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });
    if (balance >= TARGET_BALANCE) break;
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    console.log(`  Polling... balance=${balance} (${elapsed}s)`);
    await sleep(POLL_INTERVAL);
  }
  assert(balance >= TARGET_BALANCE, `USDC balance >= 0.25 (got ${Number(balance) / 1e6})`);

  // Step 5: Set up x402 client
  console.log("\n5) Set up x402 client...");
  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client();
  client.register("eip155:84532", new ExactEvmScheme(signer)); // Base Sepolia only

  const fetchPaid = wrapFetchWithPayment(fetch, client);
  assert(true, "x402 client configured");

  // Step 6: Provision project
  console.log("\n6) Provision project...");
  const createRes = await fetchPaid(`${BASE_URL}/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "openclaw-bootstrap-test" }),
  });
  const project = await createRes.json();
  assert(createRes.ok, `Project creation succeeds (status ${createRes.status})`);
  assert(typeof project.project_id === "string", "Returns project_id");
  assert(typeof project.anon_key === "string", "Returns anon_key");
  assert(typeof project.service_key === "string", "Returns service_key");

  const { project_id, anon_key, service_key } = project;
  console.log(`  Project: ${project_id}`);

  // Step 7: Create table
  console.log("\n7) Create table...");
  const createTableRes = await fetch(`${BASE_URL}/admin/v1/projects/${project_id}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${service_key}` },
    body: "CREATE TABLE notes (id serial primary key, body text not null);",
  });
  const createTableBody = await createTableRes.json();
  assert(createTableRes.ok, "CREATE TABLE succeeds");
  assert(createTableBody.schema != null, "Returns schema slot");

  await sleep(500); // Wait for PostgREST reload

  // Step 8: Write data
  console.log("\n8) Write data...");
  const writeRes = await fetch(`${BASE_URL}/rest/v1/notes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: service_key,
      Prefer: "return=representation",
    },
    body: JSON.stringify({ body: "hello from openclaw" }),
  });
  const writeBody = await writeRes.json();
  assert(writeRes.ok, `Insert succeeds (status ${writeRes.status})`);
  assert(
    Array.isArray(writeBody) && writeBody[0]?.body === "hello from openclaw",
    "Returned row matches"
  );

  // Step 9: Read data
  console.log("\n9) Read data...");
  const readRes = await fetch(`${BASE_URL}/rest/v1/notes`, {
    headers: { apikey: service_key },
  });
  const readBody = await readRes.json();
  assert(readRes.ok, "SELECT succeeds");
  assert(Array.isArray(readBody) && readBody.length === 1, "1 row returned");
  assert(readBody[0]?.body === "hello from openclaw", "Row body matches");

  // Step 10: Delete project
  console.log("\n10) Delete project...");
  const deleteRes = await fetch(`${BASE_URL}/v1/projects/${project_id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${service_key}` },
  });
  const deleteBody = await deleteRes.json();
  assert(deleteRes.ok, "Delete succeeds");
  assert(deleteBody.status === "archived", "Project archived");

  // --- Results ---
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nOpenClaw E2E test crashed:", err);
  process.exit(1);
});
