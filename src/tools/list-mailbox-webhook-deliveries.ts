import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const listMailboxWebhookDeliveriesSchema = {
  project_id: z.string().describe("The project ID"),
  status: z
    .enum(["pending", "in_flight", "delivered", "failed_permanent"])
    .optional()
    .describe("Filter by delivery status. 'failed_permanent' is the dead-letter queue (events that exhausted retries or failed permanently)."),
  limit: z.number().int().positive().max(200).optional().describe("Max rows to return (server caps at 200)"),
  after: z.string().optional().describe("Pagination cursor (delivery id from a prior page)"),
  mailbox: z
    .string()
    .optional()
    .describe("Target mailbox by slug or id; omit only when the project has exactly one mailbox."),
};

export async function handleListMailboxWebhookDeliveries(args: {
  project_id: string;
  status?: "pending" | "in_flight" | "delivered" | "failed_permanent";
  limit?: number;
  after?: string;
  mailbox?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().email.webhooks.listDeliveries(args.project_id, {
      status: args.status,
      limit: args.limit,
      after: args.after,
      mailbox: args.mailbox,
    });
    if (!body.deliveries || body.deliveries.length === 0) {
      return { content: [{ type: "text", text: "## Webhook deliveries\n\n_No deliveries match._" }] };
    }

    const lines = [
      `## Webhook deliveries (${body.deliveries.length})`,
      ``,
      `Delivery is at-least-once — consumers must dedupe on the envelope idempotency_key.`,
      ``,
      `| Delivery | Webhook | Event | Status | Attempts | Last | Created |`,
      `|----------|---------|-------|--------|----------|------|---------|`,
    ];
    for (const d of body.deliveries) {
      const last = d.last_status != null ? String(d.last_status) : (d.last_error ?? "");
      lines.push(
        `| \`${d.delivery_id}\` | ${d.webhook_id ?? ""} | ${d.event_type} | ${d.status} | ${d.attempts} | ${last} | ${d.created_at} |`,
      );
    }
    if (body.has_more) lines.push(``, `_More results — paginate with \`after: "${body.next_cursor}"\`._`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (/No mailbox found/.test(msg)) {
      return { content: [{ type: "text", text: "Error: No mailbox found. Use `create_mailbox` first." }], isError: true };
    }
    return mapSdkError(err, "listing webhook deliveries");
  }
}
