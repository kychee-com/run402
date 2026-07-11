import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

/**
 * list_project_events — the cursored project events feed (gateway
 * project-events-outbox). Returns the wire envelope verbatim: the platform
 * owns the event vocabulary, next_actions synthesis, and reset semantics;
 * this tool passes cursors through opaquely.
 */

export const listProjectEventsSchema = {
  project_id: z.string().optional().describe(
    "Project whose feed to read. Omit when passing org_id.",
  ),
  org_id: z.string().optional().describe(
    "Read the org-wide feed instead (union across the org's projects; requires an active org membership).",
  ),
  cursor: z.string().optional().describe(
    "Opaque cursor from a prior page (the response's `cursor`, or any event's `id`). Returns events strictly after it. Omit on first contact to start from the earliest retained event. Never parse cursors.",
  ),
  limit: z.number().int().min(1).max(200).optional().describe(
    "Page size (default 50, max 200).",
  ),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleListProjectEvents(args: {
  project_id?: string;
  org_id?: string;
  cursor?: string;
  limit?: number;
}): Promise<McpResult> {
  if (!args.project_id && !args.org_id) {
    return {
      content: [{ type: "text", text: "Pass project_id (per-project feed) or org_id (org-wide union)." }],
      isError: true,
    };
  }
  if (args.project_id && args.org_id) {
    return {
      content: [{ type: "text", text: "Pass either project_id or org_id, not both — the org feed already unions every project the org owns." }],
      isError: true,
    };
  }
  const opts: { cursor?: string; limit?: number } = {};
  if (args.cursor !== undefined) opts.cursor = args.cursor;
  if (args.limit !== undefined) opts.limit = args.limit;
  try {
    const page = args.org_id
      ? await getSdk().events.listForOrg(args.org_id, opts)
      : await getSdk().events.list(args.project_id!, opts);
    return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "reading project events feed");
  }
}
