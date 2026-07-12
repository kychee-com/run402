import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

/**
 * errors_list — the release-error-rollup query surface (gateway
 * release-error-rollup). Returns the verdict-first wire envelope verbatim: the
 * gateway owns the fingerprinting, the previous-active baseline, and the
 * promote-vs-revert verdict; this tool never recomputes them. In list mode it
 * pages grouped error identities; with `fingerprint_id` it fetches one
 * fingerprint's full detail row (all samples + per-sample runnable logs
 * commands + also_seen_in_functions).
 */

export const errorsListSchema = {
  project_id: z.string().describe(
    "Project whose errors to read. Authorized with the project's OWN service key; a key for a different project gets 403, never a 404.",
  ),
  fingerprint_id: z.string().optional().describe(
    "Fetch ONE fingerprint's full detail (all samples, per-sample fetch_logs commands, also_seen_in_functions) instead of a page. When set, all filter params (since/until/function/kind/fingerprint/new_in/limit/cursor) are rejected.",
  ),
  since: z.string().optional().describe(
    "ISO-8601 window start. Default window is the last 24h (gateway resolves `until` − 24h).",
  ),
  until: z.string().optional().describe(
    "ISO-8601 window end. Defaults to now (gateway-side).",
  ),
  function: z.string().optional().describe(
    "Restrict to one function by name.",
  ),
  kind: z.enum(["uncaught", "boot_crash", "invoke_failed", "handled_5xx"]).optional().describe(
    "Restrict to one choke-point class: uncaught | boot_crash | invoke_failed | handled_5xx.",
  ),
  fingerprint: z.string().optional().describe(
    "Restrict the list to one exact fingerprint identity (`fp_…`).",
  ),
  new_in: z.string().optional().describe(
    'A release id, or the literal "active" (gateway resolves the live release). Selects error identities FIRST seen under that release and drives the verdict\'s new_fingerprints / baseline — the promote-gate signal.',
  ),
  limit: z.number().int().min(1).max(200).optional().describe(
    "Page size (default 50, max 200).",
  ),
  cursor: z.string().optional().describe(
    "Opaque `next_cursor` from a prior page. Returns the next page. Never parse cursors.",
  ),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleErrorsList(args: {
  project_id: string;
  fingerprint_id?: string;
  since?: string;
  until?: string;
  function?: string;
  kind?: "uncaught" | "boot_crash" | "invoke_failed" | "handled_5xx";
  fingerprint?: string;
  new_in?: string;
  limit?: number;
  cursor?: string;
}): Promise<McpResult> {
  if (args.fingerprint_id) {
    const combinedFilters =
      args.since !== undefined ||
      args.until !== undefined ||
      args.function !== undefined ||
      args.kind !== undefined ||
      args.fingerprint !== undefined ||
      args.new_in !== undefined ||
      args.limit !== undefined ||
      args.cursor !== undefined;
    if (combinedFilters) {
      return {
        content: [
          {
            type: "text",
            text: "fingerprint_id fetches a single detail row — drop the list filters (since/until/function/kind/fingerprint/new_in/limit/cursor).",
          },
        ],
        isError: true,
      };
    }
    try {
      const detail = await getSdk().errors.get(args.project_id, args.fingerprint_id);
      return { content: [{ type: "text", text: JSON.stringify(detail, null, 2) }] };
    } catch (err) {
      return mapSdkError(err, "reading an error fingerprint");
    }
  }

  const opts: {
    since?: string;
    until?: string;
    function?: string;
    kind?: "uncaught" | "boot_crash" | "invoke_failed" | "handled_5xx";
    fingerprint?: string;
    newIn?: string;
    limit?: number;
    cursor?: string;
  } = {};
  if (args.since !== undefined) opts.since = args.since;
  if (args.until !== undefined) opts.until = args.until;
  if (args.function !== undefined) opts.function = args.function;
  if (args.kind !== undefined) opts.kind = args.kind;
  if (args.fingerprint !== undefined) opts.fingerprint = args.fingerprint;
  if (args.new_in !== undefined) opts.newIn = args.new_in;
  if (args.limit !== undefined) opts.limit = args.limit;
  if (args.cursor !== undefined) opts.cursor = args.cursor;
  try {
    const page = await getSdk().errors.list(args.project_id, opts);
    return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "reading release error fingerprints");
  }
}
