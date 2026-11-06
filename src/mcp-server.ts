/**
 * The MCP server, in-house: the stdio transport and the server side of the
 * protocol this package uses, so a customer's install carries no MCP library
 * (and none of the HTTP framework one brings).
 *
 * Framing is newline-delimited JSON-RPC 2.0 on stdin and stdout; stdout
 * carries nothing else. The server answers `initialize`, `ping`,
 * `tools/list` and `tools/call`, accepts notifications without answering,
 * and answers any other request with `-32601`. Tool argument and result
 * problems are ordinary tool results, never protocol errors, as the MCP SDK
 * this replaced answered them.
 */
import type { Readable, Writable } from "node:stream";

import { argumentError, type StrictSchema } from "./input-guard.js";
import { toJsonSchema, type AnySchema } from "./schema.js";

/** Newest first: the version a client gets when it asks for one this server does not know. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;

type JsonRpcId = string | number;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface RegisteredTool {
  description: string;
  inputSchema: StrictSchema;
  outputSchema: AnySchema;
  handler: (args: never) => ToolResult | Promise<ToolResult>;
  listing: Record<string, unknown>;
}

function textError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function rpcError(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number";
}

export class McpServer {
  readonly #tools = new Map<string, RegisteredTool>();

  constructor(readonly info: { name: string; version: string }) {}

  /** The same call shape the MCP SDK's `registerTool` had, so the registrations in `index.ts` read as before. */
  registerTool<S extends StrictSchema>(
    name: string,
    config: { description: string; inputSchema: S; outputSchema: AnySchema },
    handler: (args: S["_output"]) => ToolResult | Promise<ToolResult>,
  ): void {
    if (this.#tools.has(name)) throw new Error(`Tool ${name} is already registered`);
    this.#tools.set(name, {
      ...config,
      handler: handler as RegisteredTool["handler"],
      // The listing entry as the MCP SDK published it (key order included), built once.
      listing: {
        name,
        description: config.description,
        inputSchema: toJsonSchema(config.inputSchema),
        execution: { taskSupport: "forbidden" },
        outputSchema: toJsonSchema(config.outputSchema),
      },
    });
  }

  /** The tool names, in registration order. */
  toolNames(): string[] {
    return [...this.#tools.keys()];
  }

  /**
   * One decoded JSON-RPC message in, the response out; `undefined` for a
   * notification or a client response, which are never answered.
   */
  async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return rpcError(null, JSONRPC_INVALID_REQUEST, "Invalid Request");
    }
    const m = message as { id?: unknown; method?: unknown; params?: unknown };
    const hasId = isId(m.id);
    if (typeof m.method !== "string") {
      // A response to a request this server never sends, or junk: answer junk that carries an id.
      return "result" in m || "error" in m ? undefined : rpcError(hasId ? (m.id as JsonRpcId) : null, JSONRPC_INVALID_REQUEST, "Invalid Request");
    }
    if (!hasId) return undefined; // notifications/initialized, notifications/cancelled, and any other notification
    const id = m.id as JsonRpcId;
    const params = (typeof m.params === "object" && m.params !== null ? m.params : {}) as Record<string, unknown>;
    switch (m.method) {
      case "initialize":
        return { jsonrpc: "2.0", id, result: this.#initialize(params) };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: [...this.#tools.values()].map((t) => t.listing) } };
      case "tools/call":
        return { jsonrpc: "2.0", id, result: await this.#call(params) };
      default:
        return rpcError(id, JSONRPC_METHOD_NOT_FOUND, "Method not found");
    }
  }

  #initialize(params: Record<string, unknown>): Record<string, unknown> {
    const requested = params.protocolVersion;
    const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
    return { protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { ...this.info } };
  }

  async #call(params: Record<string, unknown>): Promise<ToolResult> {
    const name = typeof params.name === "string" ? params.name : "";
    const tool = this.#tools.get(name);
    if (!tool) return textError(`MCP error ${JSONRPC_INVALID_PARAMS}: Tool ${name} not found`);
    const refusal = argumentError(name, tool.inputSchema, params.arguments);
    if (refusal) {
      return { content: [{ type: "text", text: `Error: ${refusal.message}` }], structuredContent: { status: "error", error: refusal }, isError: true };
    }
    const args = tool.inputSchema.parse(params.arguments ?? {});
    let result: ToolResult;
    try {
      result = await tool.handler(args as never);
    } catch (err) {
      return textError(err instanceof Error ? err.message : String(err));
    }
    return this.#checkOutput(name, tool, result);
  }

  /** A successful result's structuredContent must satisfy the tool's output schema, as the MCP SDK checked it. */
  #checkOutput(name: string, tool: RegisteredTool, result: ToolResult): ToolResult {
    if (result.isError) return result;
    if (result.structuredContent === undefined) {
      return textError(`MCP error ${JSONRPC_INVALID_PARAMS}: Output validation error: Tool ${name} has an output schema but no structured content was provided`);
    }
    const checked = tool.outputSchema.safeParse(result.structuredContent);
    if (checked.success) return result;
    const detail = checked.issues.map((i) => `${i.path.join(".") || "(result)"}: ${i.message}`).join("; ");
    return textError(`MCP error ${JSONRPC_INVALID_PARAMS}: Output validation error: Invalid structured content for tool ${name}: ${detail}`);
  }

  /**
   * Serve newline-delimited JSON-RPC on `input` and `output` until `input`
   * ends; resolves once every call in flight has answered.
   */
  listen(input: Readable, output: Writable): Promise<void> {
    const inFlight = new Set<Promise<void>>();
    const write = (response: JsonRpcResponse | undefined) => {
      if (response) output.write(`${JSON.stringify(response)}\n`);
    };
    const dispatch = (line: string) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        write(rpcError(null, JSONRPC_PARSE_ERROR, "Parse error"));
        return;
      }
      const task = this.handle(message)
        .then(write)
        .catch((err: unknown) => {
          console.error(`run402-mcp: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
    };
    let buffer = "";
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== "") dispatch(line);
      }
    });
    return new Promise((resolve) => {
      input.once("end", () => {
        if (buffer.trim() !== "") dispatch(buffer.replace(/\r$/, ""));
        buffer = "";
        void Promise.allSettled([...inFlight]).then(() => resolve());
      });
    });
  }
}
