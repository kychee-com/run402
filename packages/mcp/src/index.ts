#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { provisionSchema, handleProvision } from "./tools/provision.js";
import { runSqlSchema, handleRunSql } from "./tools/run-sql.js";
import { restQuerySchema, handleRestQuery } from "./tools/rest-query.js";
import { uploadFileSchema, handleUploadFile } from "./tools/upload-file.js";
import { renewSchema, handleRenew } from "./tools/renew.js";
import { deploySiteSchema, handleDeploySite } from "./tools/deploy-site.js";
import { claimSubdomainSchema, handleClaimSubdomain } from "./tools/subdomain.js";
import { deleteSubdomainSchema, handleDeleteSubdomain } from "./tools/subdomain.js";
import { deployFunctionSchema, handleDeployFunction } from "./tools/deploy-function.js";
import { invokeFunctionSchema, handleInvokeFunction } from "./tools/invoke-function.js";
import { getFunctionLogsSchema, handleGetFunctionLogs } from "./tools/get-function-logs.js";
import { setSecretSchema, handleSetSecret } from "./tools/set-secret.js";

const server = new McpServer({
  name: "run402",
  version: "0.1.0",
});

server.tool(
  "provision_postgres_project",
  "Provision a new Postgres database. Returns project credentials on success, or payment details if x402 payment is needed.",
  provisionSchema,
  async (args) => handleProvision(args),
);

server.tool(
  "run_sql",
  "Execute SQL (DDL or queries) against a provisioned project. Returns results as a markdown table.",
  runSqlSchema,
  async (args) => handleRunSql(args),
);

server.tool(
  "rest_query",
  "Query or mutate data via the PostgREST REST API. Supports GET/POST/PATCH/DELETE with query params.",
  restQuerySchema,
  async (args) => handleRestQuery(args),
);

server.tool(
  "upload_file",
  "Upload text content to project storage. Returns the storage key and size.",
  uploadFileSchema,
  async (args) => handleUploadFile(args),
);

server.tool(
  "renew_project",
  "Renew a project's lease. Returns success or payment details if x402 payment is needed.",
  renewSchema,
  async (args) => handleRenew(args),
);

server.tool(
  "deploy_site",
  "Deploy a static site (HTML/CSS/JS). Files are uploaded to S3 and served via CloudFront at a unique URL. Costs $0.05 USDC via x402.",
  deploySiteSchema,
  async (args) => handleDeploySite(args),
);

server.tool(
  "claim_subdomain",
  "Claim a custom subdomain (e.g. myapp.run402.com) and point it at an existing deployment. Free, requires service_key auth.",
  claimSubdomainSchema,
  async (args) => handleClaimSubdomain(args),
);

server.tool(
  "delete_subdomain",
  "Release a custom subdomain. The URL will stop serving content.",
  deleteSubdomainSchema,
  async (args) => handleDeleteSubdomain(args),
);

server.tool(
  "deploy_function",
  "Deploy a serverless function (Node 22) to a project. Handler signature: export default async (req: Request) => Response. Pre-bundled packages: stripe, openai, @anthropic-ai/sdk, resend, zod, uuid, jsonwebtoken, bcryptjs, cheerio, csv-parse.",
  deployFunctionSchema,
  async (args) => handleDeployFunction(args),
);

server.tool(
  "invoke_function",
  "Invoke a deployed function via HTTP. Returns the function's response body and status code. Useful for testing functions without building a frontend.",
  invokeFunctionSchema,
  async (args) => handleInvokeFunction(args),
);

server.tool(
  "get_function_logs",
  "Get recent logs from a deployed function. Shows console.log/error output and error stack traces from CloudWatch.",
  getFunctionLogsSchema,
  async (args) => handleGetFunctionLogs(args),
);

server.tool(
  "set_secret",
  "Set a project secret (e.g. STRIPE_SECRET_KEY). Secrets are injected as process.env variables in functions. Setting an existing key overwrites it.",
  setSecretSchema,
  async (args) => handleSetSecret(args),
);

const transport = new StdioServerTransport();
await server.connect(transport);
