/**
 * AgentDB minimal test server
 *
 * An Express server that wraps DynamoDB operations behind x402 payment gates.
 * The client (agent) pays per operation using testnet USDC on Base Sepolia.
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
  DeleteTableCommand,
  DescribeTableCommand,
  PutItemCommand,
  GetItemCommand,
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

// --- Pricing (per cost model in docs/spec.md) ---
// x402 exact scheme requires fixed prices per route. For the test we use:
//   create_table:  $0.05   (control-plane spam brake)
//   put_item:      $0.01   (covers ~1333 WRUs at $7.50/1M — generous for small items)
//   get_item:      $0.005  (covers ~3333 RRUs at $1.50/1M — generous for small items)
//   delete_table:  free    (per cost model)
// In production, data-plane pricing would be dynamic based on item size.
const PRICE_CREATE_TABLE = "$0.05";
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

// Prefix to avoid name collisions in the AWS account
const TABLE_PREFIX = "agentdb-test-";

// --- Cost tracking ---

interface CostEntry {
  operation: string;
  x402Price: string;
  awsCost: string;
  margin: string;
  timestamp: string;
}
const costLedger: CostEntry[] = [];

// AWS costs (us-east-1 on-demand): $1.25/1M WRU, $0.25/1M RRU
const AWS_COST_PER_WRU = 1.25 / 1_000_000; // $0.00000125
const AWS_COST_PER_RRU = 0.25 / 1_000_000; // $0.00000025

function recordCost(operation: string, x402Price: string, awsCostUsd: number) {
  const priceNum = parseFloat(x402Price.replace("$", ""));
  const marginPct = awsCostUsd > 0 ? ((priceNum - awsCostUsd) / priceNum * 100).toFixed(1) : "100.0";
  costLedger.push({
    operation,
    x402Price,
    awsCost: `$${awsCostUsd.toFixed(8)}`,
    margin: `${marginPct}%`,
    timestamp: new Date().toISOString(),
  });
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
        description: "Create a new table ($0.05 control-plane fee)",
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
        description: "Read an item ($0.005 — covers small items at $1.50/1M RRU)",
        mimeType: "application/json",
      },
      // DELETE is free per cost model — no payment gate
    },
    new x402ResourceServer(facilitatorClient).register(NETWORK, new ExactEvmScheme()),
  ),
);

// --- Routes ---

// POST /v1/tables — create a DynamoDB table
app.post("/v1/tables", async (req, res) => {
  const tableId = req.body.table_id || `t-${Date.now()}`;
  const dynamoTableName = `${TABLE_PREFIX}${tableId}`;

  try {
    await dynamo.send(
      new CreateTableCommand({
        TableName: dynamoTableName,
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );

    console.log(`  Creating DynamoDB table: ${dynamoTableName}`);
    await waitUntilTableExists(
      { client: dynamo, maxWaitTime: 60 },
      { TableName: dynamoTableName },
    );
    console.log(`  Table ACTIVE: ${dynamoTableName}`);

    // Create table is free on AWS but we charge a control-plane fee
    recordCost("create_table", PRICE_CREATE_TABLE, 0);

    res.json({
      table_id: tableId,
      status: "ACTIVE",
      region: AWS_REGION,
    });
  } catch (err: any) {
    console.error("Create table error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /v1/tables/:tableId/items/:pk — write an item
app.put("/v1/tables/:tableId/items/:pk", async (req, res) => {
  const dynamoTableName = `${TABLE_PREFIX}${req.params.tableId}`;
  const pk = req.params.pk;
  const data = req.body;

  try {
    // Convert JSON body to DynamoDB attribute map
    const item: Record<string, any> = { pk: { S: pk } };
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string") item[key] = { S: value };
      else if (typeof value === "number") item[key] = { N: String(value) };
      else item[key] = { S: JSON.stringify(value) };
    }

    await dynamo.send(
      new PutItemCommand({
        TableName: dynamoTableName,
        Item: item,
      }),
    );

    // Estimate item size and compute AWS cost: ceil(bytes/1024) WRUs
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    const wru = Math.ceil(itemBytes / 1024);
    const awsCost = wru * AWS_COST_PER_WRU;
    recordCost("put_item", PRICE_PUT_ITEM, awsCost);
    console.log(`  Put item pk=${pk} into ${dynamoTableName} (${itemBytes}B, ${wru} WRU)`);

    res.json({ pk, status: "ok" });
  } catch (err: any) {
    console.error("Put item error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /v1/tables/:tableId/items/:pk — read an item
app.get("/v1/tables/:tableId/items/:pk", async (req, res) => {
  const dynamoTableName = `${TABLE_PREFIX}${req.params.tableId}`;
  const pk = req.params.pk;

  try {
    const result = await dynamo.send(
      new GetItemCommand({
        TableName: dynamoTableName,
        Key: { pk: { S: pk } },
      }),
    );

    if (!result.Item) {
      res.status(404).json({ error: "Item not found" });
      return;
    }

    // Convert DynamoDB attribute map back to plain JSON
    const item: Record<string, any> = {};
    for (const [key, attr] of Object.entries(result.Item)) {
      if (attr.S !== undefined) item[key] = attr.S;
      else if (attr.N !== undefined) item[key] = Number(attr.N);
      else item[key] = attr;
    }

    // Estimate item size and compute AWS cost: ceil(bytes/4096) RRUs (strong consistent)
    const itemJson = JSON.stringify(item);
    const itemBytes = Buffer.byteLength(itemJson, "utf8");
    const rru = Math.ceil(itemBytes / 4096);
    const awsCost = rru * AWS_COST_PER_RRU;
    recordCost("get_item", PRICE_GET_ITEM, awsCost);
    console.log(`  Get item pk=${pk} from ${dynamoTableName} (${itemBytes}B, ${rru} RRU)`);

    res.json({ item });
  } catch (err: any) {
    console.error("Get item error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /v1/tables/:tableId — delete a table (paywalled)
app.delete("/v1/tables/:tableId", async (req, res) => {
  const dynamoTableName = `${TABLE_PREFIX}${req.params.tableId}`;

  try {
    await dynamo.send(new DeleteTableCommand({ TableName: dynamoTableName }));
    // Delete is free per cost model
    recordCost("delete_table", "$0.00", 0);
    console.log(`  Deleted table: ${dynamoTableName}`);
    res.json({ status: "deleted" });
  } catch (err: any) {
    console.error("Delete table error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /v1/costs — view cost ledger (free)
app.get("/v1/costs", (_req, res) => {
  const totalOps = costLedger.length;
  const totalRevenue = costLedger.reduce(
    (sum, e) => sum + parseFloat(e.x402Price.replace("$", "")),
    0,
  );
  const totalAwsCost = costLedger.reduce(
    (sum, e) => sum + parseFloat(e.awsCost.replace("$", "")),
    0,
  );
  const grossMargin = totalRevenue > 0
    ? ((totalRevenue - totalAwsCost) / totalRevenue * 100).toFixed(1)
    : "0.0";
  res.json({
    entries: costLedger,
    summary: {
      total_operations: totalOps,
      total_revenue_usd: `$${totalRevenue.toFixed(6)}`,
      total_aws_cost_usd: `$${totalAwsCost.toFixed(8)}`,
      gross_profit_usd: `$${(totalRevenue - totalAwsCost).toFixed(6)}`,
      gross_margin: `${grossMargin}%`,
      network: NETWORK,
      note: "Testnet USDC — no real money spent",
    },
  });
});

// --- Start ---

app.listen(PORT, () => {
  console.log(`\nAgentDB test server running at http://localhost:${PORT}`);
  console.log(`  Seller wallet: ${SELLER_ADDRESS}`);
  console.log(`  Network:       ${NETWORK} (Base Sepolia testnet)`);
  console.log(`  Facilitator:   ${FACILITATOR_URL}`);
  console.log(`  DynamoDB:      ${AWS_REGION} (profile: ${AWS_PROFILE})`);
  console.log(`  Pricing (per cost model):`);
  console.log(`    create_table: ${PRICE_CREATE_TABLE}`);
  console.log(`    put_item:     ${PRICE_PUT_ITEM}`);
  console.log(`    get_item:     ${PRICE_GET_ITEM}`);
  console.log(`    delete_table: free\n`);
  console.log(`Waiting for requests...\n`);
});
