import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const adminSetTierSchema = {
  org_id: z
    .string()
    .describe(
      "The organization ID whose tier to override. Format: UUID. Platform-admin only — uses the configured allowance wallet for admin auth; project owners with a non-admin SIWX wallet will receive 403 admin_required.",
    ),
  tier: z
    .enum(["prototype", "hobby", "team"])
    .describe(
      "Target tier. The gateway auto-detects whether this is a subscribe / renew / upgrade / downgrade based on the organization's current state (surfaced as `action` in the response).",
    ),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional idempotency key so a retried override is applied at most once.",
    ),
};

export async function handleAdminSetTier(args: {
  org_id: string;
  tier: "prototype" | "hobby" | "team";
  idempotency_key?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk()
      .admin.org(args.org_id)
      .setTier(
        args.tier,
        args.idempotency_key !== undefined ? { idempotencyKey: args.idempotency_key } : {},
      );
    const previousNote = body.previous_tier
      ? ` (previously \`${body.previous_tier}\`)`
      : "";
    const expiryNote = body.lease_expires_at
      ? ` Lease expires \`${body.lease_expires_at}\`.`
      : "";
    return {
      content: [
        {
          type: "text",
          text:
            `Organization \`${body.org_id}\` tier set to \`${body.tier}\`${previousNote} ` +
            `via \`${body.action}\`.${expiryNote}`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "setting organization tier");
  }
}
