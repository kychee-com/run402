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
const PRICE_PER_OP = "$0.001";

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
  timestamp: string;
}
const costLedger: CostEntry[] = [];

function recordCost(operation: string) {
  costLedger.push({
    operation,
    x402Price: PRICE_PER_OP,
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
            price: PRICE_PER_OP,
            network: NETWORK,
            payTo: SELLER_ADDRESS,
          },
        ],
        description: "Create a new table",
        mimeType: "application/json",
      },
      "PUT /v1/tables/:tableId/items/:pk": {
        accepts: [
          {
            scheme: "exact",
            price: PRICE_PER_OP,
            network: NETWORK,
            payTo: SELLER_ADDRESS,
          },
        ],
        description: "Write an item",
        mimeType: "application/json",
      },
      "GET /v1/tables/:tableId/items/:pk": {
        accepts: [
          {
            scheme: "exact",
            price: PRICE_PER_OP,
            network: NETWORK,
            payTo: SELLER_ADDRESS,
          },
        ],
        description: "Read an item",
        mimeType: "application/json",
      },
      "DELETE /v1/tables/:tableId": {
        accepts: [
          {
            scheme: "exact",
            price: PRICE_PER_OP,
            network: NETWORK,
            payTo: SELLER_ADDRESS,
          },
        ],
        description: "Delete a table",
        mimeType: "application/json",
      },
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

    recordCost("create_table");

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

    recordCost("put_item");
    console.log(`  Put item pk=${pk} into ${dynamoTableName}`);

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

    recordCost("get_item");
    console.log(`  Get item pk=${pk} from ${dynamoTableName}`);

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
    recordCost("delete_table");
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
  const totalUsd = totalOps * 0.001;
  res.json({
    entries: costLedger,
    summary: {
      total_operations: totalOps,
      total_x402_usd: `$${totalUsd.toFixed(4)}`,
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
  console.log(`  Price per op:  ${PRICE_PER_OP}\n`);
  console.log(`Waiting for requests...\n`);
});
