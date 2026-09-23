/**
 * mcp-integration.test.ts — the MCP server end to end, over stdio, against a
 * local mock gateway.
 *
 * Starts the real server (`src/index.ts`) as a child process, connects the MCP
 * client SDK to it, and drives the `run` tool the way a host does: a list, a
 * scoped chain through a handle, a refusal that names the CLI command, a
 * timeout that lists the call that completed before it, and an
 * `expand_result` of a stored value. The mock gateway is an HTTP server on
 * 127.0.0.1 that records every request, so the test also proves what did and
 * did not reach the network.
 *
 * Run:
 *   npm run test:integration:mcp
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT = "prj_integ";
const MCP_TOOLS = ["deploy", "docs", "doctor", "expand_result", "run", "status", "up", "whoami"];

let gateway: Server;
let apiBase: string;
let configDir: string;
let client: Client;
const requests: Array<{ method: string; path: string; client: string | undefined }> = [];

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  requests.push({ method: req.method ?? "GET", path, client: req.headers["run402-client"] as string | undefined });
  if (req.method === "GET" && path === `/projects/v1/admin/${PROJECT}/functions`) {
    return json(res, 200, {
      functions: [
        { name: "hello", runtime: "node22", url: `${apiBase}/functions/v1/hello` },
        { name: "nightly", runtime: "node22", url: `${apiBase}/functions/v1/nightly` },
      ],
    });
  }
  if (req.method === "GET" && path === `/projects/v1/admin/${PROJECT}/secrets`) {
    return json(res, 200, { secrets: [{ key: "STRIPE_KEY", created_at: "2026-09-01T00:00:00.000Z" }] });
  }
  return json(res, 404, { error: "Not found", code: "NOT_FOUND" });
}

interface RunEnvelope {
  status: "ok" | "error";
  value?: unknown;
  value_ref: string | null;
  shown: number;
  total: number;
  calls: Array<{ path: string; ok: boolean; code?: string }>;
  wallet: { local_label: string; address: string | null };
  error?: { code: string; message: string; next_actions: Array<{ type: string; command?: string }> };
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

/** The run envelope, read from the structured channel and checked against the text's fenced JSON. */
function envelopeOf(result: unknown): RunEnvelope {
  const blocks = [...textOf(result).matchAll(/```json\n([\s\S]*?)\n```/g)];
  const fenced = JSON.parse(blocks[blocks.length - 1]![1]!) as RunEnvelope;
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  assert.deepEqual(structured, fenced, "structuredContent is the envelope the text shows");
  return structured as RunEnvelope;
}

async function run(code: string, timeout_seconds?: number): Promise<RunEnvelope> {
  const result = await client.callTool({ name: "run", arguments: { code, ...(timeout_seconds ? { timeout_seconds } : {}) } });
  return envelopeOf(result);
}

before(async () => {
  gateway = createServer(handle);
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  assert.ok(address && typeof address === "object");
  apiBase = `http://127.0.0.1:${address.port}`;

  configDir = mkdtempSync(join(tmpdir(), "run402-mcp-integ-"));
  writeFileSync(join(configDir, "projects.json"), JSON.stringify({
    projects: { [PROJECT]: { anon_key: "anon-integ", service_key: "service-integ", tier: "prototype", lease_expires_at: "2030-01-01T00:00:00.000Z" } },
  }), { mode: 0o600 });

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("RUN402_")) env[k] = v;
  env.RUN402_API_BASE = apiBase;
  env.RUN402_CONFIG_DIR = configDir;
  env.RUN402_WALLET_LABEL_SYNC = "0";

  client = new Client({ name: "mcp-integration", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    // The server runs from a directory of its own (no wallet binding), so tsx
    // is loaded by its resolved URL rather than by name from that directory.
    args: ["--no-warnings", "--import", import.meta.resolve("tsx"), join(import.meta.dirname, "src/index.ts")],
    env,
    cwd: configDir,
    stderr: "pipe",
  }));
});

after(async () => {
  await client?.close();
  await new Promise<void>((resolve) => gateway?.close(() => resolve()));
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

describe("MCP server end to end (stdio, mock gateway)", { timeout: 120_000 }, () => {
  it("lists exactly the eight tools", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), MCP_TOOLS);
  });

  it("declares an open output schema for every tool", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.equal(tool.outputSchema?.type, "object", `${tool.name} declares an outputSchema`);
      assert.ok(!JSON.stringify(tool.outputSchema).includes('"additionalProperties":false'), `${tool.name}'s schema is open`);
    }
  });

  it("status returns structuredContent the SDK validated", async () => {
    const result = await client.callTool({ name: "status", arguments: {} });
    const body = result.structuredContent as { status: string; result: { wallet: unknown } };
    assert.equal(body.status, "ok");
    assert.ok("wallet" in body.result);
  });

  it("run: a list", async () => {
    const before = requests.length;
    const run1 = await run(`(await r.project("${PROJECT}").functions.list()).functions.map((f) => f.name)`);
    assert.equal(run1.status, "ok", JSON.stringify(run1.error));
    assert.deepEqual(run1.value, ["hello", "nightly"]);
    assert.deepEqual(run1.calls.map((c) => [c.path, c.ok]), [["project.functions.list", true]]);
    assert.equal(run1.wallet.local_label, "default");
    const sent = requests.slice(before);
    assert.deepEqual(sent.map((r) => `${r.method} ${r.path}`), [`GET /projects/v1/admin/${PROJECT}/functions`]);
    assert.match(sent[0]!.client ?? "", /surface="sandbox"/);
  });

  it("run: a scoped chain through a handle", async () => {
    const run2 = await run(
      `const p = await r.project("${PROJECT}");\n` +
      "const [fns, secrets] = await Promise.all([p.functions.list(), p.secrets.list()]);\n" +
      "({ functions: fns.functions.length, secrets: secrets.secrets.map((s) => s.key) })",
    );
    assert.equal(run2.status, "ok", JSON.stringify(run2.error));
    assert.deepEqual(run2.value, { functions: 2, secrets: ["STRIPE_KEY"] });
    assert.deepEqual(run2.calls.map((c) => c.path).sort(), ["project", "project.functions.list", "project.secrets.list"]);
  });

  it("run: a secret-returning call refuses and names the CLI command, before any request", async () => {
    const before = requests.length;
    const result = await client.callTool({
      name: "run",
      arguments: { code: `await r.project("${PROJECT}").grants.create({ wallet: "0x1111111111111111111111111111111111111111", capability: "deploy", key: true })` },
    });
    assert.equal((result as { isError?: boolean }).isError, true);
    const run3 = envelopeOf(result);
    assert.equal(run3.error?.code, "SECRET_REQUIRES_CLI");
    assert.equal(run3.error?.next_actions.length, 1);
    assert.equal(run3.error?.next_actions[0]?.type, "run_cli_command");
    assert.equal(
      run3.error?.next_actions[0]?.command,
      `run402 grants create 0x1111111111111111111111111111111111111111 --capability deploy --key --project ${PROJECT}`,
    );
    assert.equal(requests.length, before, "the refusal made no request");
  });

  it("run: a timeout lists the call that completed before it", async () => {
    const run4 = await run(`await r.project("${PROJECT}").functions.list();\nfor (;;) {}`, 1);
    assert.equal(run4.status, "error");
    assert.equal(run4.error?.code, "RUN_TIMEOUT");
    assert.deepEqual(run4.calls.map((c) => [c.path, c.ok]), [["project.functions.list", true]]);
  });

  it("expand_result pages a stored value the run did not show", async () => {
    const run5 = await run("Array.from({ length: 1000 }, (_, i) => ({ i, name: `row-${i}` }))");
    assert.equal(run5.status, "ok");
    assert.equal(run5.total, 1000, "total counts rows");
    assert.ok(run5.shown > 0 && run5.shown < 1000);
    assert.equal(run5.value, undefined, "a windowed value is not inlined whole");
    const window = (run5 as unknown as { value_window: { path: string; items: Array<{ i: number }> } }).value_window;
    assert.equal(window.path, "$");
    assert.deepEqual(window.items[0], { i: 0, name: "row-0" }, "the structured window carries whole rows");
    const page = await client.callTool({ name: "expand_result", arguments: { ref: run5.value_ref, offset: run5.shown, limit: 20 } });
    const items = (page.structuredContent as { items: Array<{ i: number; name: string }> }).items;
    assert.equal(items.length, 20);
    assert.deepEqual(items[0], { i: run5.shown, name: `row-${run5.shown}` }, "expand_result pages whole rows, never text fragments");
  });

  it("docs answers from the packaged reference without a network call", async () => {
    const before = requests.length;
    const result = await client.callTool({ name: "docs", arguments: {} });
    assert.match(textOf(result), /## `r` namespaces/);
    assert.equal(requests.length, before);
  });
});
