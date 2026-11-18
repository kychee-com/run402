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

/**
 * The structured refusal for arguments that fail a tool's strict schema, or null when they pass.
 *
 * An undeclared key is named by its dotted path from the arguments, so a key
 * nested inside an argument (`functions.patch.set.api.klass`) is never
 * reported as a top-level argument; its `did_you_mean` searches the keys the
 * object holding it declares, and `accepted_at` lists them by that object's path.
 */
export function argumentError(tool: string, schema: StrictSchema, args: unknown): ToolError | null {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return null;
  const declared = Object.keys(schema.shape);
  const unknown: string[] = [];
  const didYouMean: Record<string, string[]> = {};
  const acceptedAt: Record<string, string[]> = {};
  const hints: string[] = [];
  let topLevel = false;
  const issues: Array<{ path: string; message: string }> = [];
  for (const issue of parsed.issues) {
    if (issue.code !== "unrecognized_keys") {
      issues.push({ path: issue.path.join(".") || "(arguments)", message: issue.message });
      continue;
    }
    const at = issue.path.join(".");
    const beside = at === "" ? declared : (issue.declared ?? []);
    if (at === "") topLevel = true;
    else acceptedAt[at] = beside;
    for (const key of issue.keys ?? []) {
      const path = at === "" ? key : `${at}.${key}`;
      const near = closestMembers(key, beside);
      unknown.push(path);
      didYouMean[path] = near.map((name) => (at === "" ? name : `${at}.${name}`));
      hints.push(near.length > 0 ? `${path} (did you mean ${near.join(" or ")}?)` : path);
    }
  }
  if (unknown.length > 0) {
    const nested = Object.keys(acceptedAt);
    const noun = nested.length === 0 ? "argument" : "key";
    const takes = [
      ...(topLevel ? [`It takes: ${declared.join(", ") || "no arguments"}.`] : []),
      ...nested.map((at) => `${at} takes: ${acceptedAt[at]!.join(", ") || "no keys"}.`),
    ];
    return {
      code: "UNKNOWN_ARGUMENT",
      message: `${tool} does not take ${unknown.length === 1 ? `the ${noun}` : `the ${noun}s`} ${hints.join(", ")}. ${takes.join(" ")}`,
      next_actions: [{
        type: "edit_request",
        why: `Remove or rename the ${noun}s the tool does not declare, then call it again.`,
        tool,
        unknown,
        did_you_mean: didYouMean,
        accepted: declared,
        ...(nested.length > 0 ? { accepted_at: acceptedAt } : {}),
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
