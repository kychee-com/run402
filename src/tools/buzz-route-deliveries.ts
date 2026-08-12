import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import type { BuzzRouteDelivery } from "../../sdk/dist/index.js";

/**
 * Read-only delivery history for one Buzz project-event route — the "did it
 * actually land" read. Dead letters are included; the signed envelope never
 * is. Mutations (test / pause / resume / rotate / revoke) stay on the CLI.
 */
export const listBuzzRouteDeliveriesSchema = {
  buzz_project_event_route_id: z.string().describe("The route (buzzper_…) whose delivery history to read."),
  limit: z.number().int().min(1).max(200).optional().describe("Page size, 1–200 (gateway default 50)."),
  cursor: z.string().optional().describe("Opaque next_cursor from a previous page. Store and echo; never parse."),
  delivery_id: z
    .string()
    .optional()
    .describe("Scope to one delivery (buzzped_…) — the test-delivery poll shape."),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function deliveryLine(d: BuzzRouteDelivery): string {
  const parts = [
    `${d.buzz_project_event_delivery_id}  ${d.status.padEnd(11)} ${d.kind === "test" ? "TEST " : ""}${d.event_type} (${d.project_id})`,
    `attempts ${d.attempt_count}`,
  ];
  if (d.next_attempt_at) parts.push(`next ${d.next_attempt_at}`);
  if (d.delivered_at) parts.push(`delivered ${d.delivered_at}`);
  if (d.nostr_event_id) parts.push(`nostr ${d.nostr_event_id}`);
  if (d.suppressed_reason) parts.push(`suppressed: ${d.suppressed_reason}`);
  if (d.last_error) parts.push(`last_error: ${d.last_error}`);
  return parts.join("  ");
}

export async function handleListBuzzRouteDeliveries(args: {
  buzz_project_event_route_id: string;
  limit?: number;
  cursor?: string;
  delivery_id?: string;
}): Promise<McpResult> {
  try {
    const page = await getSdk().buzz.notifications.deliveries(args.buzz_project_event_route_id, {
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.cursor ? { cursor: args.cursor } : {}),
      ...(args.delivery_id ? { deliveryId: args.delivery_id } : {}),
    });
    if (page.buzz_project_event_deliveries.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No deliveries yet. Routes deliver NEW events only, and the publisher tick runs ~every 60s — queue a probe with: run402 buzz notifications test <buzzper_id> --wait",
          },
        ],
      };
    }
    const lines = page.buzz_project_event_deliveries.map(deliveryLine);
    if (page.has_more) lines.push(`… more (cursor ${page.next_cursor})`);
    lines.push(
      "",
      "queued/retryable are still in flight (backoff 1m/5m/30m/2h/12h to 8 attempts or 48h, then dead_letter). Retries republish byte-identically, so the relay converges on one Nostr event id.",
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing Buzz route deliveries");
  }
}
