import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const STATUS = z.enum(["settling", "settled", "settle_failed", "ambiguous"]);

export const listTenantPaymentsSchema = {
  project_id: z.string().describe("Project id, e.g. `prj_...`."),
  status: STATUS.optional().describe("Optional status filter."),
  limit: z.number().int().positive().max(200).optional().describe("Page size. Server default 50, max 200."),
  after: z.string().optional().describe("Opaque keyset cursor from a previous next_cursor."),
};

export async function handleListTenantPayments(args: {
  project_id: string;
  status?: "settling" | "settled" | "settle_failed" | "ambiguous";
  limit?: number;
  after?: string;
}): Promise<ToolResult> {
  try {
    const page = await getSdk().projects.listTenantPayments(args.project_id, {
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.after !== undefined ? { after: args.after } : {}),
    });
    const lines = [
      `Tenant x402 payments for \`${page.project_id}\` (${page.payments.length}):`,
    ];
    if (page.payments.length === 0) {
      lines.push("_No tenant payments found._");
    } else {
      lines.push("| Payment | Status | Route | Amount | Payer | Settlement | Request |");
      lines.push("|---|---|---|---:|---|---|---|");
      for (const p of page.payments) {
        const route = `${p.route_method} ${p.route_pattern}`;
        const settlement = p.settlement_tx_hash ?? p.settlement_reference ?? "—";
        lines.push(
          `| \`${p.payment_id}\` | ${p.status} | ${route} | ${p.amount_usd_micros} | ${p.payer ?? "—"} | ${settlement} | ${p.request_id ?? "—"} |`,
        );
      }
    }
    if (page.has_more && page.next_cursor) {
      lines.push("", `_More results — pass after: "${page.next_cursor}" to fetch the next page._`);
    }
    return {
      content: [
        { type: "text", text: lines.join("\n") },
        { type: "text", text: JSON.stringify(page, null, 2) },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "listing tenant payments");
  }
}
