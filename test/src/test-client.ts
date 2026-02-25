/**
 * AgentDB minimal test client — multi-tenant architecture
 *
 * Simulates an agent that:
 *   1. Creates a logical table (pays $0.02 via x402 — metadata insert, sub-second)
 *   2. Writes an item to the shared table (pays $0.01 via x402)
 *   3. Reads it back (pays $0.005 via x402 — includes egress metering)
 *   4. Fetches cost report with 5-category breakdown
 *   5. Cleans up (deletes logical table — free, TTL-based in production)
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
  console.log("\n=== AgentDB Multi-Tenant Test ===\n");
  console.log(`Buyer wallet: ${signer.address}`);
  console.log(`Server:       ${BASE_URL}`);
  console.log(`Architecture: Shared multi-tenant table (PK-prefixed)\n`);

  const tableId = `test-${Date.now()}`;

  // Step 1: Create logical table ($0.02 — metadata insert, no AWS CreateTable)
  console.log("1) Creating logical table ($0.02 — metadata insert, sub-second)...");
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
  console.log(`   Storage: ${createBody.storage}`);
  logPayment(createRes, "create_table");

  // Step 2: Write an item (PK-prefixed into shared table)
  console.log("\n2) Writing item to shared table (PK-prefixed)...");
  const item = {
    name: "AgentDB multi-tenant test item",
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
  if (putBody.headers) {
    console.log(`   Metered: ${putBody.headers["X-Metered-Units"]} WRU, ${putBody.headers["X-Metered-Egress-Bytes"]}B egress`);
  }
  logPayment(putRes, "put_item");

  // Step 3: Read it back (with egress metering)
  console.log("\n3) Reading item back (with egress metering)...");
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
  const egressBytes = getRes.headers.get("X-Metered-Egress-Bytes");
  const meteredUnits = getRes.headers.get("X-Metered-Units");
  if (egressBytes || meteredUnits) {
    console.log(`   Metered: ${meteredUnits} RRU, ${egressBytes}B egress`);
  }
  logPayment(getRes, "get_item");

  // Step 4: Cost report (5-category breakdown)
  console.log("\n4) Cost report (5-category model)...");
  const costRes = await fetch(`${BASE_URL}/v1/costs`); // free endpoint, no x402
  const costBody = await costRes.json();
  console.log("   Operations:");
  for (const entry of costBody.entries) {
    console.log(
      `     ${entry.operation}: charged ${entry.x402Price}` +
      ` | DynamoDB ${entry.dynamoCost}` +
      ` | egress ${entry.egressCost}` +
      ` | metering ${entry.meteringCost}` +
      ` | margin: ${entry.margin}`,
    );
  }
  console.log(`\n   Revenue:          ${costBody.summary.total_revenue_usd}`);
  console.log(`   Cost breakdown:`);
  const bd = costBody.summary.cost_breakdown;
  console.log(`     A) DynamoDB var:  ${bd.A_dynamo_variable}`);
  console.log(`     B) Egress:        ${bd.B_egress}`);
  console.log(`     C) Fixed infra:   ${bd.C_fixed_infra}`);
  console.log(`     D) Facilitation:  ${bd.D_payment_facilitation}`);
  console.log(`     E) Metering:      ${bd.E_metering_overhead}`);
  console.log(`   Total var cost:   ${costBody.summary.total_variable_aws_cost_usd}`);
  console.log(`   Egress bytes:     ${costBody.summary.total_egress_bytes}`);
  console.log(`   Gross profit:     ${costBody.summary.gross_profit_usd}`);
  console.log(`   Gross margin:     ${costBody.summary.gross_margin}`);
  console.log(`   Architecture:     ${costBody.summary.architecture}`);
  console.log(`   (${costBody.summary.note})`);

  // Step 5: Delete logical table (free — TTL-based cleanup in production)
  console.log("\n5) Deleting logical table (free — TTL sweep in production)...");
  const delRes = await fetch(`${BASE_URL}/v1/tables/${tableId}`, {
    method: "DELETE",
  });
  const delBody = await delRes.json();
  if (!delRes.ok) {
    console.error("   FAILED:", delBody);
    process.exit(1);
  }
  console.log(`   ${delBody.status} — ${delBody.items_cleaned} items cleaned`);
  console.log(`   Method: ${delBody.method}`);

  console.log("\n=== Test complete ===\n");
}

main().catch((err) => {
  console.error("\nTest failed:", err);
  process.exit(1);
});
