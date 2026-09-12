import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import type { LightningTopup } from "../../sdk/dist/index.js";

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export const createLightningTopupSchema = {
  org_id: z.string().describe("Organization ID to top up"),
  amount_sats: z.number().int().min(100).max(1_000_000).describe("Whole satoshis (100–1,000,000)"),
  idempotency_key: z.string().optional().describe("Optional replay-safe key: the same key returns the same top-up"),
};

export const getTopupSchema = {
  org_id: z.string().describe("Organization ID"),
  topup_id: z.string().describe("The topup_id from create_lightning_topup"),
};

function render(t: LightningTopup, title: string): string {
  const usd = (t.amount_usd_micros / 1_000_000).toFixed(2);
  const lines = [
    `## ${title}`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| organization | \`${t.org_id}\` |`,
    `| topup_id | \`${t.topup_id}\` |`,
    `| status | ${t.status} |`,
    `| amount | ${t.amount_sats ?? "?"} sats (≈ $${usd}, quoted at mint) |`,
    `| expires | ${t.invoice_expires_at ?? "-"} |`,
    ...(t.paid_at ? [`| paid_at | ${t.paid_at} |`] : []),
    ...(t.credited_ledger_id ? [`| ledger | \`${t.credited_ledger_id}\` |`] : []),
  ];
  if (t.status === "pending" && t.bolt11) {
    lines.push(``, `Pay from any Lightning wallet:`, ``, `\`\`\``, `lightning:${t.bolt11}`, `\`\`\``, ``, `Then call \`get_topup\` until the status is \`paid\`.`);
  } else if (t.status === "paid" || t.status === "paid_late") {
    lines.push(``, `The balance was credited $${usd}${t.status === "paid_late" ? " (paid after the invoice expired; still credited)" : ""}.`);
  } else if (t.status === "expired") {
    lines.push(``, `The invoice expired unpaid. Mint a fresh one with \`create_lightning_topup\`.`);
  }
  return lines.join("\n");
}

export async function handleCreateLightningTopup(args: { org_id: string; amount_sats: number; idempotency_key?: string }): Promise<McpResult> {
  try {
    const topup = await getSdk().billing.createLightningTopup(args.org_id, { amountSats: args.amount_sats, idempotencyKey: args.idempotency_key });
    return { content: [{ type: "text", text: render(topup, "Lightning top-up invoice") }] };
  } catch (err) {
    return mapSdkError(err, "creating Lightning top-up");
  }
}

export async function handleGetTopup(args: { org_id: string; topup_id: string }): Promise<McpResult> {
  try {
    const topup = await getSdk().billing.getTopup(args.org_id, args.topup_id);
    return { content: [{ type: "text", text: render(topup, "Top-up") }] };
  } catch (err) {
    return mapSdkError(err, "reading top-up");
  }
}
