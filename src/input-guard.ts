/**
 * Tool arguments are strict: an argument a tool does not declare is refused,
 * never silently dropped.
 *
 * Every tool is registered with its strict schema (`strictInput`), so the
 * published JSON Schema says `additionalProperties: false`, and the server
 * (`mcp-server.ts`) checks each `tools/call` against the same schema before
 * the handler runs, answering a failure with the structured error:
 * `UNKNOWN_ARGUMENT` (with the closest declared names) or `INVALID_ARGUMENTS`.
 */

import { z, type ObjectSchema, type RawShape } from "./schema.js";
import { closestMembers } from "./sandbox-proxy.js";
import type { ToolError } from "./structured.js";

/** A tool's input shape as a strict object: unknown keys fail. */
export function strictInput<T extends RawShape>(shape: T) {
  return z.object(shape).strict();
}

/** A tool's strict input schema, whatever its shape (`any`: `refine` makes schemas invariant). */
export type StrictSchema = ObjectSchema<any, "strict">;

/** The structured refusal for arguments that fail a tool's strict schema, or null when they pass. */
export function argumentError(tool: string, schema: StrictSchema, args: unknown): ToolError | null {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return null;
  const declared = Object.keys(schema.shape);
  const unknown: string[] = [];
  const issues: Array<{ path: string; message: string }> = [];
  for (const issue of parsed.issues) {
    if (issue.code === "unrecognized_keys") unknown.push(...(issue.keys ?? []));
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
