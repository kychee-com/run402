import { z } from "zod";
import { apiRequest } from "../client.js";
import { formatApiError } from "../errors.js";

export const setTierSchema = {
  tier: z
    .enum(["prototype", "hobby", "team"])
    .describe("Target tier — subscribes, renews, or upgrades automatically based on wallet state"),
};

export async function handleSetTier(args: {
  tier: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const res = await apiRequest(`/tiers/v1/${args.tier}`, {
    method: "POST",
    body: {},
  });

  if (res.is402) {
    const body = res.body as Record<string, unknown>;
    const lines = [
      `## Payment Required`,
      ``,
      `To set tier **${args.tier}**, an x402 payment is needed.`,
      ``,
    ];
    if (body.x402) {
      lines.push(`**Payment details:**`);
      lines.push("```json");
      lines.push(JSON.stringify(body.x402, null, 2));
      lines.push("```");
    } else {
      lines.push(`**Server response:**`);
      lines.push("```json");
      lines.push(JSON.stringify(body, null, 2));
      lines.push("```");
    }
    lines.push(``);
    lines.push(
      `The user's agent allowance or payment agent must send the required amount. ` +
      `Once payment is confirmed, retry this tool call.`,
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (!res.ok) return formatApiError(res, "setting tier");

  const body = res.body as {
    wallet: string;
    action: string;
    tier: string;
    previous_tier: string | null;
    lease_started_at: string;
    lease_expires_at: string;
    allowance_remaining_usd_micros: number;
  };

  const lines = [
    `## Tier ${body.action === "subscribe" ? "Subscribed" : body.action === "renew" ? "Renewed" : "Upgraded"}`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| action | ${body.action} |`,
    `| tier | ${body.tier} |`,
  ];
  if (body.previous_tier) {
    lines.push(`| previous_tier | ${body.previous_tier} |`);
  }
  lines.push(
    `| expires | ${body.lease_expires_at} |`,
    `| allowance | $${(body.allowance_remaining_usd_micros / 1_000_000).toFixed(2)} |`,
  );

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
