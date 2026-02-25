/**
 * AgentDB minimal test server — multi-tenant architecture
 *
 * An Express server that wraps DynamoDB operations behind x402 payment gates.
 * Uses a **shared multi-tenant DynamoDB table** (`agentdb-data-001`) with
 * PK-prefixed logical isolation, matching the revised spec.
 *
 * Key changes from v1:
 *   - No CreateTable/DeleteTable per logical table — single shared table
 *   - PK format: "{tableId}#{userPK}", SK: "{userSK}" (or "#" sentinel)
 *   - All DynamoDB calls include ReturnConsumedCapacity: TOTAL
 *   - Egress metering on read responses ($0.30/GB)
 *   - Revised pricing: create $0.02, table-day $0.005, storage $1.50/GB-mo
 *
 * Run: npm run server
 */

import { config } from "dotenv";
config();

import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  PutItemCommand,
  GetItemCommand,
  DeleteItemCommand,
  QueryCommand,
  UpdateItemCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { fromSSO } from "@aws-sdk/credential-providers";

// --- Config ---

const PORT = 4021;
const SELLER_ADDRESS = process.env.SELLER_ADDRESS as `0x${string}`;
const AWS_PROFILE = process.env.AWS_PROFILE || "kychee";
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const FACILITATOR_URL = "https://x402.org/facilitator";
const NETWORK = "eip155:84532"; // Base Sepolia testnet

// Shared multi-tenant table (one table for all customer data)
const SHARED_TABLE = "agentdb-data-001";
const GSI_NAME = "gsi-tid-pk";

// --- Pricing (revised cost model — see docs/spec.md) ---
// x402 exact scheme requires fixed prices per route. For the test we use:
//   create_table:  $0.02   (metadata insert, sub-second — was $0.05)
//   put_item:      $0.01   (covers ~1333 WRUs at $7.50/1M — generous for small items)
//   get_item:      $0.005  (covers ~3333 RRUs at $1.50/1M + egress — generous for small items)
//   delete_table:  free    (per cost model)
// In production, data-plane pricing would be dynamic based on item size + egress.
const PRICE_CREATE_TABLE = "$0.02";
const PRICE_PUT_ITEM = "$0.01";
const PRICE_GET_ITEM = "$0.005";

if (!SELLER_ADDRESS) {
  console.error("Missing SELLER_ADDRESS in .env — run: npm run generate-wallets");
  process.exit(1);
}

// --- AWS DynamoDB client ---

const dynamo = new DynamoDBClient({
  region: AWS_REGION,
  credentials: fromSSO({ profile: AWS_PROFILE }),
});

// --- Cost tracking (5-category model) ---

interface CostEntry {
  operation: string;
  x402Price: string;
  dynamoCost: string;     // A. DynamoDB variable cost (from ConsumedCapacity)
  egressCost: string;     // B. Egress cost
  meteringCost: string;   // E. Internal metering overhead
  totalAwsCost: string;   // A + B + E (C and D are fixed/per-tx, tracked in summary)
  margin: string;
  consumedCapacity: number;
  egressBytes: number;
  timestamp: string;
}
const costLedger: CostEntry[] = [];

// AWS costs (us-east-1 on-demand)
const AWS_COST_PER_WRU = 1.25 / 1_000_000;   // $0.00000125
const AWS_COST_PER_RRU = 0.25 / 1_000_000;   // $0.00000025
const AWS_COST_PER_GB_EGRESS = 0.09;          // ~$0.09/GB after 100GB free tier
const METERING_OVERHEAD_WRU = 1;              // ~1 WRU per request for ledger update

// Retail prices
const RETAIL_PER_GB_EGRESS = 0.30;            // $0.30/GB

function recordCost(
  operation: string,
  x402Price: string,
  consumedCapacityUnits: number,
  isWrite: boolean,
  egressBytes: number,
) {
  const priceNum = parseFloat(x402Price.replace("$", ""));
  const costPerUnit = isWrite ? AWS_COST_PER_WRU : AWS_COST_PER_RRU;
  const dynamoCost = consumedCapacityUnits * costPerUnit;
  const egressCost = (egressBytes / (1024 * 1024 * 1024)) * AWS_COST_PER_GB_EGRESS;
  const meterCost = METERING_OVERHEAD_WRU * AWS_COST_PER_WRU; // ledger update
  const totalAwsCost = dynamoCost + egressCost + meterCost;
  const marginPct = priceNum > 0
    ? ((priceNum - totalAwsCost) / priceNum * 100).toFixed(1)
    : "100.0";

  costLedger.push({
    operation,
    x402Price,
    dynamoCost: `$${dynamoCost.toFixed(8)}`,
    egressCost: `$${egressCost.toFixed(8)}`,
    meteringCost: `$${meterCost.toFixed(8)}`,
    totalAwsCost: `$${totalAwsCost.toFixed(8)}`,
    margin: `${marginPct}%`,
    consumedCapacity: consumedCapacityUnits,
    egressBytes,
    timestamp: new Date().toISOString(),
  });
}

// --- Logical table metadata (in-memory for test; production uses DynamoDB metadata table) ---

interface TableMetadata {
  tableId: string;
  walletId: string;
  status: "ACTIVE" | "DELETED";
  createdAt: string;
}
const tableRegistry = new Map<string, TableMetadata>();

// --- Ensure shared table exists on startup ---

async function ensureSharedTable() {
  try {
    await dynamo.send(new DescribeTableCommand({ TableName: SHARED_TABLE }));
    console.log(`  Shared table "${SHARED_TABLE}" already exists`);
  } catch (err: any) {
    if (err.name === "ResourceNotFoundException") {
      console.log(`  Creating shared table "${SHARED_TABLE}" with GSI...`);
      await dynamo.send(
        new CreateTableCommand({
          TableName: SHARED_TABLE,
          KeySchema: [
            { AttributeName: "PK", KeyType: "HASH" },
            { AttributeName: "SK", KeyType: "RANGE" },
          ],
          AttributeDefinitions: [
            { AttributeName: "PK", AttributeType: "S" },
            { AttributeName: "SK", AttributeType: "S" },
            { AttributeName: "_tid", AttributeType: "S" },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: GSI_NAME,
              KeySchema: [
                { AttributeName: "_tid", KeyType: "HASH" },
                { AttributeName: "PK", KeyType: "RANGE" },
              ],
              Projection: { ProjectionType: "ALL" },
            },
          ],
          BillingMode: "PAY_PER_REQUEST",
        }),
      );
      await waitUntilTableExists(
        { client: dynamo, maxWaitTime: 60 },
        { TableName: SHARED_TABLE },
      );
      console.log(`  Shared table "${SHARED_TABLE}" ACTIVE (one-time setup)`);
    } else {
      throw err;
    }
  }
}

// --- Express app ---

const app = express();
app.use(express.json());

// x402 payment middleware — gates specific routes
const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

app.use(
  paymentMiddleware(
    {
      "POST /v1/tables": {
        accepts: [
          {
            scheme: "exact",
            price: PRICE_CREATE_TABLE,
            network: NETWORK,
            payTo: SELLER_ADDRESS,
          },
        ],
        description: "Create a new logical table ($0.02 metadata insert — no AWS CreateTable)",
        mimeType: "application/json",
      },
      "PUT /v1/tables/:tableId/items/:pk": {
        accepts: [
          {
            scheme: "exact",
            price: PRICE_PUT_ITEM,
            network: NETWORK,
            payTo: SELLER_ADDRESS,
          },
        ],
        description: "Write an item ($0.01 — covers small items at $7.50/1M WRU)",
        mimeType: "application/json",
      },
      "GET /v1/tables/:tableId/items/:pk": {
        accepts: [
          {
            scheme: "exact",
            price: PRICE_GET_ITEM,
            network: NETWORK,
            payTo: SELLER_ADDRESS,
          },
        ],
        description: "Read an item ($0.005 — covers small items at $1.50/1M RRU + $0.30/GB egress)",
        mimeType: "application/json",
      },
      // DELETE is free per cost model — no payment gate
    },
    new x402ResourceServer(facilitatorClient).register(NETWORK, new ExactEvmScheme()),
  ),
);

// --- Routes ---

// POST /v1/tables — create a logical table (metadata insert, sub-second)
app.post("/v1/tables", async (req, res) => {
  const tableId = req.body.table_id || `t-${Date.now()}`;

  // In the multi-tenant model, "create table" is a metadata insert — no AWS CreateTable
  const metadata: TableMetadata = {
    tableId,
    walletId: "test-wallet", // in production: extracted from x402 payer identity
    status: "ACTIVE",
    createdAt: new Date().toISOString(),
  };
  tableRegistry.set(tableId, metadata);

  // Record cost: metadata insert costs ~1 WRU (small item)
  // The $0.02 fee covers this plus control-plane overhead
  recordCost("create_table", PRICE_CREATE_TABLE, 1, true, 0);
  console.log(`  Created logical table: ${tableId} (metadata only — no AWS CreateTable)`);

  res.json({
    table_id: tableId,
    status: "ACTIVE",
    region: AWS_REGION,
    storage: "shared multi-tenant (agentdb-data-001)",
  });
});

// PUT /v1/tables/:tableId/items/:pk — write an item to the shared table
app.put("/v1/tables/:tableId/items/:pk", async (req, res) => {
  const { tableId } = req.params;
  const pk = req.params.pk;
  const data = req.body;

  // Verify logical table exists and is active
  const meta = tableRegistry.get(tableId);
  if (!meta || meta.status !== "ACTIVE") {
    res.status(404).json({ error: "Table not found or deleted" });
    return;
  }

  try {
    // Build DynamoDB item with multi-tenant PK prefix
    const compositePK = `${tableId}#${pk}`;
    const item: Record<string, any> = {
      PK: { S: compositePK },
      SK: { S: "#" }, // sentinel — no sort key in this test
      _wid: { S: meta.walletId },
      _tid: { S: tableId },
    };

    // Add user data attributes
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string") item[key] = { S: value };
      else if (typeof value === "number") item[key] = { N: String(value) };
      else item[key] = { S: JSON.stringify(value) };
    }

    // Compute item size for _sz attribute
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    item._sz = { N: String(itemBytes) };

    const result = await dynamo.send(
      new PutItemCommand({
        TableName: SHARED_TABLE,
        Item: item,
        ReturnConsumedCapacity: "TOTAL",
      }),
    );

    const consumed = result.ConsumedCapacity?.CapacityUnits ?? Math.ceil(itemBytes / 1024);
    recordCost("put_item", PRICE_PUT_ITEM, consumed, true, 0);
    console.log(
      `  Put item PK="${compositePK}" (${itemBytes}B, ${consumed} WRU actual via ConsumedCapacity)`,
    );

    res.json({
      pk,
      status: "ok",
      headers: {
        "X-Metered-Units": consumed,
        "X-Metered-Egress-Bytes": 0,
      },
    });
  } catch (err: any) {
    console.error("Put item error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /v1/tables/:tableId/items/:pk — read an item from the shared table
app.get("/v1/tables/:tableId/items/:pk", async (req, res) => {
  const { tableId } = req.params;
  const pk = req.params.pk;

  const meta = tableRegistry.get(tableId);
  if (!meta || meta.status !== "ACTIVE") {
    res.status(404).json({ error: "Table not found or deleted" });
    return;
  }

  try {
    const compositePK = `${tableId}#${pk}`;
    const result = await dynamo.send(
      new GetItemCommand({
        TableName: SHARED_TABLE,
        Key: {
          PK: { S: compositePK },
          SK: { S: "#" },
        },
        ReturnConsumedCapacity: "TOTAL",
      }),
    );

    if (!result.Item) {
      res.status(404).json({ error: "Item not found" });
      return;
    }

    // Convert DynamoDB attribute map back to plain JSON, stripping internal attributes
    const item: Record<string, any> = {};
    for (const [key, attr] of Object.entries(result.Item)) {
      // Skip internal multi-tenant attributes
      if (key === "PK" || key === "SK" || key.startsWith("_")) continue;
      if (attr.S !== undefined) item[key] = attr.S;
      else if (attr.N !== undefined) item[key] = Number(attr.N);
      else item[key] = attr;
    }

    // Compute egress: byteLength of the HTTP response body
    const responseBody = JSON.stringify({ item });
    const egressBytes = Buffer.byteLength(responseBody, "utf8");
    const consumed = result.ConsumedCapacity?.CapacityUnits ?? 1;

    recordCost("get_item", PRICE_GET_ITEM, consumed, false, egressBytes);
    console.log(
      `  Get item PK="${compositePK}" (${consumed} RRU actual, ${egressBytes}B egress)`,
    );

    // Set metering headers
    res.set("X-Metered-Units", String(consumed));
    res.set("X-Metered-Egress-Bytes", String(egressBytes));
    res.json({ item });
  } catch (err: any) {
    console.error("Get item error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /v1/tables/:tableId — delete a logical table (set metadata DELETED + TTL items)
app.delete("/v1/tables/:tableId", async (req, res) => {
  const { tableId } = req.params;

  const meta = tableRegistry.get(tableId);
  if (!meta) {
    res.status(404).json({ error: "Table not found" });
    return;
  }

  try {
    // In the multi-tenant model, "delete table" means:
    // 1. Set metadata to DELETED
    // 2. Set _ttl on all items for DynamoDB TTL-based cleanup
    //
    // For this test, we directly delete items to clean up immediately.
    // In production, we'd set _ttl and let DynamoDB's TTL sweeper handle it.

    // Query items belonging to this logical table via the GSI
    const queryResult = await dynamo.send(
      new QueryCommand({
        TableName: SHARED_TABLE,
        IndexName: GSI_NAME,
        KeyConditionExpression: "#tid = :tid",
        ExpressionAttributeNames: { "#tid": "_tid" },
        ExpressionAttributeValues: { ":tid": { S: tableId } },
        ReturnConsumedCapacity: "TOTAL",
      }),
    );

    const itemCount = queryResult.Items?.length ?? 0;

    // Delete each item (in production: set _ttl instead)
    for (const item of queryResult.Items ?? []) {
      await dynamo.send(
        new DeleteItemCommand({
          TableName: SHARED_TABLE,
          Key: {
            PK: item.PK,
            SK: item.SK,
          },
        }),
      );
    }

    // Mark metadata as DELETED
    meta.status = "DELETED";

    recordCost("delete_table", "$0.00", 0, false, 0);
    console.log(
      `  Deleted logical table: ${tableId} (cleaned up ${itemCount} items — ` +
      `production would use TTL sweep)`,
    );

    res.json({
      status: "deleted",
      items_cleaned: itemCount,
      method: "direct delete (test) — production uses TTL sweep",
    });
  } catch (err: any) {
    console.error("Delete table error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /v1/costs — view cost ledger with 5-category breakdown (free)
app.get("/v1/costs", (_req, res) => {
  const totalOps = costLedger.length;
  const totalRevenue = costLedger.reduce(
    (sum, e) => sum + parseFloat(e.x402Price.replace("$", "")),
    0,
  );
  const totalDynamoCost = costLedger.reduce(
    (sum, e) => sum + parseFloat(e.dynamoCost.replace("$", "")),
    0,
  );
  const totalEgressCost = costLedger.reduce(
    (sum, e) => sum + parseFloat(e.egressCost.replace("$", "")),
    0,
  );
  const totalMeteringCost = costLedger.reduce(
    (sum, e) => sum + parseFloat(e.meteringCost.replace("$", "")),
    0,
  );
  const totalAwsCost = totalDynamoCost + totalEgressCost + totalMeteringCost;
  const totalEgressBytes = costLedger.reduce((sum, e) => sum + e.egressBytes, 0);
  const grossMargin = totalRevenue > 0
    ? ((totalRevenue - totalAwsCost) / totalRevenue * 100).toFixed(1)
    : "0.0";

  res.json({
    entries: costLedger,
    summary: {
      total_operations: totalOps,
      total_revenue_usd: `$${totalRevenue.toFixed(6)}`,
      cost_breakdown: {
        "A_dynamo_variable": `$${totalDynamoCost.toFixed(8)}`,
        "B_egress": `$${totalEgressCost.toFixed(8)}`,
        "C_fixed_infra": "~$50-100/mo (not tracked per-request)",
        "D_payment_facilitation": "<$0.01/tx on Base L2 (not tracked per-request)",
        "E_metering_overhead": `$${totalMeteringCost.toFixed(8)}`,
      },
      total_variable_aws_cost_usd: `$${totalAwsCost.toFixed(8)}`,
      total_egress_bytes: totalEgressBytes,
      gross_profit_usd: `$${(totalRevenue - totalAwsCost).toFixed(6)}`,
      gross_margin: `${grossMargin}%`,
      network: NETWORK,
      architecture: "shared multi-tenant table (agentdb-data-001)",
      note: "Testnet USDC — no real money spent. Fixed infra + facilitation costs not included in per-request margin.",
    },
  });
});

// --- Start ---

async function start() {
  await ensureSharedTable();

  app.listen(PORT, () => {
    console.log(`\nAgentDB test server running at http://localhost:${PORT}`);
    console.log(`  Seller wallet:  ${SELLER_ADDRESS}`);
    console.log(`  Network:        ${NETWORK} (Base Sepolia testnet)`);
    console.log(`  Facilitator:    ${FACILITATOR_URL}`);
    console.log(`  DynamoDB:       ${AWS_REGION} (profile: ${AWS_PROFILE})`);
    console.log(`  Shared table:   ${SHARED_TABLE}`);
    console.log(`  Architecture:   Multi-tenant (PK-prefixed, GSI for scans)`);
    console.log(`  Pricing (revised cost model):`);
    console.log(`    create_table: ${PRICE_CREATE_TABLE} (metadata insert — no AWS CreateTable)`);
    console.log(`    put_item:     ${PRICE_PUT_ITEM} (+ $0.30/GB egress on reads)`);
    console.log(`    get_item:     ${PRICE_GET_ITEM} (+ egress metering)`);
    console.log(`    delete_table: free (TTL sweep in production)\n`);
    console.log(`Waiting for requests...\n`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
