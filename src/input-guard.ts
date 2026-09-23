/**
 * Tool arguments are strict: an argument a tool does not declare is refused,
 * never silently dropped.
 *
 * Every tool is registered with its strict schema (`strictInput`), so the
 * published JSON Schema says `additionalProperties: false` and the MCP SDK
 * itself refuses an unknown key. The SDK reports its refusal as plain text,
 * though, and every run402-mcp error carries `structuredContent`. So the
 * guard below validates a `tools/call` against the same strict schema before
 * the SDK sees it, and answers a failure itself with the structured error:
 * `UNKNOWN_ARGUMENT` (with the closest declared names) or `INVALID_ARGUMENTS`.
 * A valid call passes through untouched.
 */

import { z } from "zod";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { closestMembers } from "./sandbox-proxy.js";
import type { ToolError } from "./structured.js";

/** A tool's input shape as a strict object: unknown keys fail. */
export function strictInput<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}

type StrictSchema = z.ZodObject<z.ZodRawShape, "strict">;

/** The structured refusal for arguments that fail a tool's strict schema, or null when they pass. */
export function argumentError(tool: string, schema: StrictSchema, args: unknown): ToolError | null {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return null;
  const declared = Object.keys(schema.shape);
  const unknown: string[] = [];
  const issues: Array<{ path: string; message: string }> = [];
  for (const issue of parsed.error.issues) {
    if (issue.code === "unrecognized_keys") unknown.push(...issue.keys);
    else issues.push({ path: issue.path.join(".") || "(arguments)", message: issue.message });
  }
  if (unknown.length > 0) {
    const didYouMean: Record<string, string[]> = {};
    for (const key of unknown) didYouMean[key] = closestMembers(key, declared);
    const hints = unknown
      .map((key) => (didYouMean[key]!.length > 0 ? `${key} (did you mean ${didYouMean[key]!.join(" or ")}?)` : key))
      .join(", ");
    return {
      code: "UNKNOWN_ARGUMENT",
      message: `${tool} does not take ${unknown.length === 1 ? "the argument" : "the arguments"} ${hints}. It takes: ${declared.join(", ") || "no arguments"}.`,
      next_actions: [{
        type: "edit_request",
        why: "Remove or rename the arguments the tool does not declare, then call it again.",
        tool,
        unknown,
        did_you_mean: didYouMean,
        accepted: declared,
      }],
      details: { unknown, ...(issues.length > 0 ? { issues } : {}) },
    };
  }
  return {
    code: "INVALID_ARGUMENTS",
    message: `${tool}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    next_actions: [{ type: "edit_request", why: "Fix the arguments named in details.issues, then call the tool again.", tool }],
    details: { issues },
  };
}

function isToolCall(message: JSONRPCMessage): message is JSONRPCMessage & { id: string | number; method: "tools/call"; params: { name: string; arguments?: unknown } } {
  const m = message as { method?: unknown; id?: unknown; params?: { name?: unknown } };
  return m.method === "tools/call" && (typeof m.id === "string" || typeof m.id === "number") && typeof m.params?.name === "string";
}

/**
 * Refuse invalid tool arguments with a structured result before the server
 * dispatches the call. Install after `server.connect(transport)`, which sets
 * the transport's `onmessage`.
 */
export function guardToolArguments(transport: Transport, schemas: Record<string, StrictSchema>): void {
  const dispatch = transport.onmessage;
  if (!dispatch) throw new Error("guardToolArguments: install after server.connect(transport)");
  transport.onmessage = (message, extra) => {
    if (isToolCall(message)) {
      const schema = schemas[message.params.name];
      const error = schema ? argumentError(message.params.name, schema, message.params.arguments) : null;
      if (error) {
        void transport.send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            structuredContent: { status: "error", error },
            isError: true,
          },
        });
        return;
      }
    }
    dispatch.call(transport, message, extra);
  };
}
