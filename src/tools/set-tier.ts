import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { PaymentRequired } from "../../sdk/dist/index.js";
import { RUN402_MPP_LIGHTNING_PROFILE, type PaymentPreference } from "../../sdk/dist/index.js";
import { paymentPreferenceSchema } from "./pay-url.js";

export const setTierSchema = {
  tier: z
    .enum(["prototype", "hobby", "team"])
    .describe("Target tier — subscribes, renews, or upgrades automatically based on wallet state"),
  idempotency_key: z.string().min(1).optional()
    .describe("Stable caller key; required whenever Lightning can be selected"),
  payment_preferences: z.array(paymentPreferenceSchema).min(1).max(16).optional(),
  profile: z.literal(RUN402_MPP_LIGHTNING_PROFILE).optional(),
  max_usd_micros: z.number().int().nonnegative().optional(),
  max_native_amount_msat: z.number().int().nonnegative().optional(),
  max_routing_fee_msat: z.number().int().nonnegative().optional(),
  evidence_policy: z.enum(["none", "protocol_settlement", "run402_settlement", "merchant_fulfillment"]).optional(),
  organization_id: z.string().min(1).optional(),
};

export async function handleSetTier(args: {
  tier: string;
  idempotency_key?: string;
  payment_preferences?: PaymentPreference[];
  profile?: typeof RUN402_MPP_LIGHTNING_PROFILE;
  max_usd_micros?: number;
  max_native_amount_msat?: number;
  max_routing_fee_msat?: number;
  evidence_policy?: "none" | "protocol_settlement" | "run402_settlement" | "merchant_fulfillment";
  organization_id?: string;
}, deps: { getSdk?: typeof getSdk } = {}): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}> {
  try {
    const lightning = args.payment_preferences?.some((item) =>
      item.protocol === "mpp" && item.method === "lightning") ?? false;
    const body = await (deps.getSdk?.() ?? getSdk()).tier.set(
      args.tier as "prototype" | "hobby" | "team", {
      ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
      ...(args.payment_preferences ? { paymentPreferences: args.payment_preferences } : {}),
      ...(args.profile ? { profile: args.profile } : {}),
      ...(args.max_usd_micros !== undefined ? { maxUsdMicros: args.max_usd_micros } : {}),
      ...(args.max_native_amount_msat !== undefined
        ? { maxNativeAmountMsat: args.max_native_amount_msat } : {}),
      ...(args.max_routing_fee_msat !== undefined
        ? { maxRoutingFeeMsat: args.max_routing_fee_msat } : {}),
      ...(args.evidence_policy ? { evidencePolicy: args.evidence_policy } : {}),
      ...(args.organization_id ? { organizationId: args.organization_id } : {}),
      ...(lightning ? { principalTransport: "siwx" as const } : {}),
      },
    );

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

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: body as unknown as Record<string, unknown>,
    };
  } catch (err) {
    if (err instanceof PaymentRequired) {
      const body = (err.body ?? {}) as Record<string, unknown>;
      const lines = [
        `## Payment Required`,
        ``,
        `To set tier **${args.tier}**, payment is needed.`,
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
    return mapSdkError(err, "setting tier");
  }
}
