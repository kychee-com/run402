/**
 * AgentDB minimal test client
 *
 * Simulates an agent that:
 *   1. Creates a table (pays via x402)
 *   2. Writes an item (pays via x402)
 *   3. Reads it back (pays via x402)
 *   4. Fetches cost report
 *   5. Cleans up (deletes table, free)
 *
 * Run: npm run test  (while server is running in another terminal)
 */

import { config } from "dotenv";
config();

import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

// --- Config ---

const BUYER_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const BASE_URL = "http://localhost:4021";

if (!BUYER_KEY) {
  console.error("Missing BUYER_PRIVATE_KEY in .env — run: npm run generate-wallets");
  process.exit(1);
}

// --- Setup x402 client ---

// The EVM scheme needs readContract (to check USDC balance etc.)
// so we compose the signer from a local account + a public RPC client
const account = privateKeyToAccount(BUYER_KEY);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(signer));

const fetchPaid = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

// --- Helpers ---

function logPayment(response: Response, label: string) {
  try {
    const payment = httpClient.getPaymentSettleResponse(
      (name) => response.headers.get(name),
    );
    if (payment) {
      console.log(`  x402 payment settled for "${label}"`);
      console.log(`    transaction: ${JSON.stringify(payment).slice(0, 120)}...`);
    }
  } catch {
    // Payment response header not always present (e.g. when middleware
    // settles but doesn't echo the header back for every route).
    console.log(`  x402 payment completed for "${label}" (no settlement header)`);
  }
}

// --- Main test flow ---

async function main() {
  console.log("\n=== AgentDB Minimal Test ===\n");
  console.log(`Buyer wallet: ${signer.address}`);
  console.log(`Server:       ${BASE_URL}\n`);

  const tableId = `test-${Date.now()}`;

  // Step 1: Create table
  console.log("1) Creating table...");
  const createRes = await fetchPaid(`${BASE_URL}/v1/tables`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ table_id: tableId }),
  });
  const createBody = await createRes.json();
  if (!createRes.ok) {
    console.error("   FAILED:", createBody);
    process.exit(1);
  }
  console.log(`   Table created: ${createBody.table_id} (${createBody.status})`);
  logPayment(createRes, "create_table");

  // Step 2: Write an item
  console.log("\n2) Writing item...");
  const item = {
    name: "AgentDB test item",
    created_by: "test-client",
    value: 42,
    timestamp: new Date().toISOString(),
  };
  const putRes = await fetchPaid(`${BASE_URL}/v1/tables/${tableId}/items/hello-world`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(item),
  });
  const putBody = await putRes.json();
  if (!putRes.ok) {
    console.error("   FAILED:", putBody);
    process.exit(1);
  }
  console.log(`   Item written: pk=${putBody.pk}`);
  logPayment(putRes, "put_item");

  // Step 3: Read it back
  console.log("\n3) Reading item back...");
  const getRes = await fetchPaid(`${BASE_URL}/v1/tables/${tableId}/items/hello-world`, {
    method: "GET",
  });
  const getBody = await getRes.json();
  if (!getRes.ok) {
    console.error("   FAILED:", getBody);
    process.exit(1);
  }
  console.log("   Item read back:");
  console.log("  ", JSON.stringify(getBody.item, null, 2).replace(/\n/g, "\n   "));
  logPayment(getRes, "get_item");

  // Step 4: Cost report
  console.log("\n4) Cost report...");
  const costRes = await fetch(`${BASE_URL}/v1/costs`); // free endpoint, no x402
  const costBody = await costRes.json();
  console.log("   Operations:");
  for (const entry of costBody.entries) {
    console.log(`     ${entry.operation}: ${entry.x402Price} at ${entry.timestamp}`);
  }
  console.log(`\n   TOTAL: ${costBody.summary.total_operations} ops, ${costBody.summary.total_x402_usd}`);
  console.log(`   (${costBody.summary.note})`);

  // Step 5: Delete table (paywalled)
  console.log("\n5) Deleting table...");
  const delRes = await fetchPaid(`${BASE_URL}/v1/tables/${tableId}`, {
    method: "DELETE",
  });
  const delBody = await delRes.json();
  if (!delRes.ok) {
    console.error("   FAILED:", delBody);
    process.exit(1);
  }
  console.log(`   ${delBody.status}`);
  logPayment(delRes, "delete_table");

  console.log("\n=== Test complete ===\n");
}

main().catch((err) => {
  console.error("\nTest failed:", err);
  process.exit(1);
});
