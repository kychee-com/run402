import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { McpServer, SUPPORTED_PROTOCOL_VERSIONS, type JsonRpcResponse, type ToolResult } from "./mcp-server.js";
import { strictInput } from "./input-guard.js";
import { z } from "./schema.js";

const ok = (structuredContent: unknown): ToolResult => ({ content: [{ type: "text", text: "ok" }], structuredContent });

function makeServer() {
  const server = new McpServer({ name: "run402", version: "9.9.9" });
  const calls: unknown[] = [];
  server.registerTool(
    "echo",
    { description: "Echo.", inputSchema: strictInput({ text: z.string(), nested: z.object({ keep: z.string() }).optional() }), outputSchema: z.object({ status: z.enum(["ok", "error"]) }).loose() },
    async (args) => {
      calls.push(args);
      return ok({ status: "ok", echoed: args.text });
    },
  );
  server.registerTool("broken", { description: "Returns the wrong shape.", inputSchema: strictInput({}), outputSchema: z.object({ status: z.enum(["ok", "error"]) }).loose() }, async () => ok({ nope: 1 }));
  server.registerTool("throws", { description: "Throws.", inputSchema: strictInput({}), outputSchema: z.object({}).loose() }, async () => {
    throw new Error("boom");
  });
  return { server, calls };
}

const call = (server: McpServer, name: string, args?: unknown) =>
  server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, ...(args === undefined ? {} : { arguments: args }) } }) as Promise<JsonRpcResponse & { result: ToolResult & { structuredContent?: { status?: string; error?: { code: string; next_actions: Array<Record<string, unknown>> } } } }>;

describe("initialize", () => {
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    it(`answers with the version asked for: ${version}`, async () => {
      const { server } = makeServer();
      const reply = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      assert.deepEqual(reply, { jsonrpc: "2.0", id: 1, result: { protocolVersion: version, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "run402", version: "9.9.9" } } });
    });
  }
  it("answers an unknown version with its newest", async () => {
    const { server } = makeServer();
    const reply = await server.handle({ jsonrpc: "2.0", id: "a", method: "initialize", params: { protocolVersion: "1999-01-01" } });
    assert.equal((reply?.result as { protocolVersion: string }).protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
  });
});

describe("methods", () => {
  it("answers ping", async () => {
    assert.deepEqual(await makeServer().server.handle({ jsonrpc: "2.0", id: 2, method: "ping" }), { jsonrpc: "2.0", id: 2, result: {} });
  });
  it("lists the tools in registration order, each as the MCP SDK published it", async () => {
    const reply = await makeServer().server.handle({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    const tools = (reply?.result as { tools: Array<Record<string, unknown>> }).tools;
    assert.deepEqual(tools.map((t) => t.name), ["echo", "broken", "throws"]);
    assert.deepEqual(Object.keys(tools[0]!), ["name", "description", "inputSchema", "execution", "outputSchema"]);
    assert.deepEqual(tools[0]!.execution, { taskSupport: "forbidden" });
    assert.equal((tools[0]!.inputSchema as { additionalProperties: boolean }).additionalProperties, false);
  });
  it("answers an unknown method with -32601 and never answers a notification", async () => {
    const { server } = makeServer();
    assert.deepEqual(await server.handle({ jsonrpc: "2.0", id: 4, method: "resources/list" }), { jsonrpc: "2.0", id: 4, error: { code: -32601, message: "Method not found" } });
    assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
    assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }), undefined);
    assert.equal(await server.handle({ jsonrpc: "2.0", id: 5, result: {} }), undefined);
  });
  it("answers a malformed request with -32600", async () => {
    const { server } = makeServer();
    assert.equal((await server.handle([1, 2]))?.error?.code, -32600);
    assert.equal((await server.handle({ jsonrpc: "2.0", id: 6 }))?.error?.code, -32600);
  });
});

describe("tools/call", () => {
  it("runs the handler with the parsed arguments (undeclared nested keys stripped, as zod did)", async () => {
    const { server, calls } = makeServer();
    const reply = await call(server, "echo", { text: "hi", nested: { keep: "k", drop: 1 } });
    assert.equal(reply.result.isError, undefined);
    assert.deepEqual(reply.result.structuredContent, { status: "ok", echoed: "hi" });
    assert.deepEqual(calls, [{ text: "hi", nested: { keep: "k" } }]);
  });
  it("refuses an unknown argument with UNKNOWN_ARGUMENT before the handler runs", async () => {
    const { server, calls } = makeServer();
    const reply = await call(server, "echo", { text: "hi", txet: 1 });
    assert.equal(reply.result.isError, true);
    assert.equal(reply.result.structuredContent?.status, "error");
    assert.equal(reply.result.structuredContent?.error?.code, "UNKNOWN_ARGUMENT");
    assert.deepEqual(reply.result.structuredContent?.error?.next_actions[0]?.unknown, ["txet"]);
    assert.equal(calls.length, 0);
  });
  it("refuses a wrongly typed argument with INVALID_ARGUMENTS", async () => {
    const { server, calls } = makeServer();
    const reply = await call(server, "echo", { text: 42 });
    assert.equal(reply.result.structuredContent?.error?.code, "INVALID_ARGUMENTS");
    assert.equal(calls.length, 0);
  });
  it("treats absent arguments as {}", async () => {
    const reply = await call(makeServer().server, "echo");
    assert.equal(reply.result.structuredContent?.error?.code, "INVALID_ARGUMENTS");
  });
  it("answers an unknown tool, a thrown handler and a bad result as text-only tool errors, never protocol errors", async () => {
    const { server } = makeServer();
    for (const [name, pattern] of [["missing", /Tool missing not found/], ["throws", /^boom$/], ["broken", /Output validation error/]] as const) {
      const reply = await call(server, name, {});
      assert.equal(reply.error, undefined, name);
      assert.equal(reply.result.isError, true, name);
      assert.match(reply.result.content[0]!.text, pattern, name);
    }
  });
});

describe("listen", () => {
  function pipes() {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: unknown[] = [];
    let buffer = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
    });
    return { input, output, lines };
  }

  it("frames by newline across chunk boundaries, accepts CRLF, skips blank lines, answers bad JSON with -32700, and ends with stdin", async () => {
    const { server } = makeServer();
    const { input, output, lines } = pipes();
    const done = server.listen(input, output);
    input.write('{"jsonrpc":"2.0","id":1,"method":"pi');
    input.write('ng"}\r\n\n');
    input.write("not json\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "x" } } }));
    input.end(); // the last line has no newline; it is still served
    await done;
    assert.deepEqual(lines.find((l) => (l as { id: unknown }).id === 1), { jsonrpc: "2.0", id: 1, result: {} });
    assert.deepEqual(lines.find((l) => (l as { id: unknown }).id === null), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    assert.equal(((lines.find((l) => (l as { id: unknown }).id === 2) as { result: ToolResult }).result.structuredContent as { echoed: string }).echoed, "x");
    assert.equal(lines.length, 3);
  });

  it("finishes a call in flight before resolving", async () => {
    const server = new McpServer({ name: "run402", version: "0" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    server.registerTool("slow", { description: "Slow.", inputSchema: strictInput({}), outputSchema: z.object({}).loose() }, async () => {
      await gate;
      return ok({ status: "ok" });
    });
    const { input, output, lines } = pipes();
    let resolved = false;
    const done = server.listen(input, output).then(() => { resolved = true; });
    input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "slow", arguments: {} } })}\n`);
    await new Promise((r) => setImmediate(r));
    assert.equal(resolved, false);
    release();
    await done;
    assert.equal(lines.length, 1);
  });
});
