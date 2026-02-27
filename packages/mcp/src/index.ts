#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { provisionSchema, handleProvision } from "./tools/provision.js";
import { runSqlSchema, handleRunSql } from "./tools/run-sql.js";
import { restQuerySchema, handleRestQuery } from "./tools/rest-query.js";
import { uploadFileSchema, handleUploadFile } from "./tools/upload-file.js";
import { renewSchema, handleRenew } from "./tools/renew.js";

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

const transport = new StdioServerTransport();
await server.connect(transport);
