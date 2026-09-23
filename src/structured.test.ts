/**
 * The structured channel: the error normalizer, the prose/structured
 * agreement, and the output schemas as an MCP client sees them.
 *
 * Run: node --test --import tsx src/structured.test.ts
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ApiError,
  NetworkError,
  PaymentRequired,
  ProjectNotFound,
  Run402DeployError,
} from "../sdk/dist/index.js";
import { mapSdkError } from "./errors.js";
import {
  DEPLOY_ERROR_LOG_LINES,
  OUTPUT_SCHEMAS,
  toolErrorFrom,
  toolErrorSchema,
} from "./structured.js";
import { handleExpandResult, expandResultSchema } from "./tools/expand-result.js";
import { handleDocs, docsSchema } from "./tools/docs.js";
import { _resetResultStore, storeResult } from "./result-store.js";

const MCP_TOOLS = ["up", "deploy", "status", "whoami", "doctor", "docs", "run", "expand_result"] as const;

describe("toolErrorFrom", () => {
  it("copies a gateway error's own code and fields", () => {
    const err = new ApiError("Forbidden", 403, {
      code: "NOT_AUTHORIZED",
      message: "Not a member of this org.",
      category: "authorization",
      retryable: false,
      trace_id: "trc_1",
      details: { required_role: "owner" },
      next_actions: [{ type: "request_membership", why: "Ask an owner to add you." }],
    }, "reading status");
    const e = toolErrorFrom(err, "reading status");
    toolErrorSchema.parse(e);
    assert.equal(e.code, "NOT_AUTHORIZED");
    assert.equal(e.message, "Not a member of this org.");
    assert.equal(e.http_status, 403);
    assert.equal(e.category, "authorization");
    assert.equal(e.retryable, false);
    assert.equal(e.trace_id, "trc_1");
    assert.deepEqual(e.details, { required_role: "owner" });
    assert.deepEqual(e.next_actions, [{ type: "request_membership", why: "Ask an owner to add you." }]);
  });

  it("gives local codes to failures that carry none", () => {
    assert.equal(toolErrorFrom(new NetworkError("socket hang up", new Error("x"), "reading status")).code, "NETWORK_ERROR");
    const missing = toolErrorFrom(new ProjectNotFound("prj_x", "deploying"));
    assert.equal(missing.code, "PROJECT_NOT_FOUND");
    assert.equal(missing.next_actions.length, 1);
    const plain = toolErrorFrom(new Error("boom"), "running doctor");
    assert.equal(plain.code, "INTERNAL_ERROR");
    assert.match(plain.message, /boom/);
    assert.deepEqual(plain.next_actions, []);
  });

  it("keeps a payment failure's own code and next actions", () => {
    const err = new PaymentRequired("Payment required", 402, {
      code: "PAYMENT_REQUIRED",
      next_actions: [{ type: "top_up_allowance", why: "Top up the allowance." }],
    }, "deploying release");
    const e = toolErrorFrom(err);
    assert.equal(e.code, "PAYMENT_REQUIRED");
    assert.equal(e.http_status, 402);
    assert.equal(e.next_actions[0]!.type, "top_up_allowance");
  });

  it("adds the deploy fields and caps the logs", () => {
    const logs = Array.from({ length: DEPLOY_ERROR_LOG_LINES + 20 }, (_, i) => `line ${i}`);
    const err = new Run402DeployError("Migration failed.", {
      code: "MIGRATION_FAILED",
      phase: "migrate",
      resource: "database.migrations.001_init",
      operationId: "op_1",
      planId: "plan_1",
      logs,
      fix: { action: "edit_migration" },
      body: { code: "MIGRATION_FAILED", message: "Migration failed.", next_actions: [{ type: "edit_migration" }] },
    } as ConstructorParameters<typeof Run402DeployError>[1]);
    const e = toolErrorFrom(err);
    toolErrorSchema.parse(e);
    assert.equal(e.code, "MIGRATION_FAILED");
    assert.equal(e.phase, "migrate");
    assert.equal(e.resource, "database.migrations.001_init");
    assert.equal(e.operation_id, "op_1");
    assert.equal(e.plan_id, "plan_1");
    assert.deepEqual(e.fix, { action: "edit_migration" });
    assert.equal(e.logs!.length, DEPLOY_ERROR_LOG_LINES);
  });
});

describe("mapSdkError", () => {
  it("returns the structured error beside prose that names the same code and next actions", () => {
    const err = new ApiError("Forbidden", 403, {
      code: "NOT_AUTHORIZED",
      message: "Not a member of this org.",
      next_actions: [{ type: "request_membership", label: "Ask an owner" }],
    }, "reading status");
    const result = mapSdkError(err, "reading status");
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, "error");
    const e = toolErrorSchema.parse(result.structuredContent.error);
    const text = result.content[0]!.text;
    assert.ok(text.includes(`\`${e.code}\``), "the prose names the structured code");
    for (const action of e.next_actions) assert.ok(text.includes(String(action.type)), `the prose names next action ${String(action.type)}`);
  });

  it("structures a bare throwable too", () => {
    const result = mapSdkError(new Error("boom"), "running doctor");
    assert.equal(result.isError, true);
    assert.equal(toolErrorSchema.parse(result.structuredContent.error).code, "INTERNAL_ERROR");
  });
});

/** Walk a JSON Schema and collect every path that forbids extra properties. */
function closedPaths(schema: unknown, path = "$"): string[] {
  if (!schema || typeof schema !== "object") return [];
  const out: string[] = [];
  const obj = schema as Record<string, unknown>;
  if (obj.additionalProperties === false) out.push(path);
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === "object") out.push(...closedPaths(value, `${path}.${key}`));
  }
  return out;
}

describe("output schemas through an MCP client", () => {
  let client: Client;

  beforeEach(async () => {
    _resetResultStore();
    const server = new McpServer({ name: "structured-test", version: "0.0.0" });
    for (const name of MCP_TOOLS) {
      if (name === "expand_result") {
        server.registerTool(name, { description: name, inputSchema: expandResultSchema, outputSchema: OUTPUT_SCHEMAS[name] }, async (args) => handleExpandResult(args));
      } else if (name === "docs") {
        server.registerTool(name, { description: name, inputSchema: docsSchema, outputSchema: OUTPUT_SCHEMAS[name] }, async (args) => handleDocs(args));
      } else {
        server.registerTool(name, { description: name, inputSchema: {}, outputSchema: OUTPUT_SCHEMAS[name] }, async () => ({ content: [{ type: "text" as const, text: "" }], structuredContent: { status: "ok" } }));
      }
    }
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "structured-test-client", version: "0.0.0" });
    await client.connect(clientSide);
  });

  afterEach(async () => {
    await client.close();
  });

  it("publishes an open output schema for every tool", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...MCP_TOOLS].sort());
    for (const tool of tools) {
      assert.ok(tool.outputSchema, `${tool.name} has an outputSchema`);
      assert.equal(tool.outputSchema!.type, "object");
      assert.deepEqual(closedPaths(tool.outputSchema), [], `${tool.name}'s schema never forbids extra fields`);
      const status = (tool.outputSchema!.properties as Record<string, { enum?: string[] }>).status;
      assert.deepEqual(status?.enum, ["ok", "error"], `${tool.name} declares status`);
    }
  });

  it("delivers structuredContent that passes the SDK's own validation", async () => {
    const stored = storeResult("test", ["a", "b", "c"], { shown: 1 });
    const page = await client.callTool({ name: "expand_result", arguments: { ref: stored.ref, offset: 1 } });
    assert.equal(page.isError, undefined);
    assert.deepEqual(page.structuredContent, { status: "ok", ref: stored.ref, kind: "test", offset: 1, shown: 2, total: 3, items: ["b", "c"] });

    const docs = await client.callTool({ name: "docs", arguments: {} });
    assert.equal(docs.isError, undefined);
    const body = docs.structuredContent as Record<string, unknown>;
    assert.equal(body.status, "ok");
    assert.ok(Array.isArray(body.lines) && (body.lines as unknown[]).length > 0);
  });

  it("delivers a structured error for an unknown ref", async () => {
    const missing = await client.callTool({ name: "expand_result", arguments: { ref: "res_0000000000000000" } });
    assert.equal(missing.isError, true);
    const body = missing.structuredContent as { status: string; error: unknown };
    assert.equal(body.status, "error");
    const e = toolErrorSchema.parse(body.error);
    assert.equal(e.code, "RESULT_REF_NOT_FOUND");
    assert.equal(e.next_actions.length, 1);

    const topic = await client.callTool({ name: "docs", arguments: { topic: "no-such-topic" } });
    assert.equal(topic.isError, true);
    assert.equal(toolErrorSchema.parse((topic.structuredContent as { error: unknown }).error).code, "DOCS_TOPIC_NOT_FOUND");
  });
});
