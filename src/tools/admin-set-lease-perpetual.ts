import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const adminSetLeasePerpetualSchema = {
  org_id: z
    .string()
    .describe(
      "The organization ID to toggle. Format: UUID. Platform-admin only — uses the configured allowance wallet for admin auth; project owners with a non-admin SIWX wallet will receive 403 admin_required.",
    ),
  lease_perpetual: z
    .boolean()
    .describe(
      "true → pin every project in the organization (organization never advances past 'active' regardless of lease expiry). false → resume normal lifecycle advancement. Enabling on a grace-state organization reactivates inline (response includes `reactivated: true`). Replaces the v1.56 per-project pin (gateway endpoint /projects/v1/admin/:id/pin was removed in v1.57).",
    ),
};

export async function handleAdminSetLeasePerpetual(args: {
  org_id: string;
  lease_perpetual: boolean;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const adminOrg = getSdk().admin.org(args.org_id);
    const body = args.lease_perpetual
      ? await adminOrg.pinLease()
      : await adminOrg.unpinLease();
    const reactivatedNote = body.reactivated
      ? " The organization was in a grace state and got pulled back to `active` inline."
      : "";
    return {
      content: [
        {
          type: "text",
          text: `Organization \`${body.org_id}\` now has \`lease_perpetual=${body.lease_perpetual}\`.${reactivatedNote}`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "setting organization lease_perpetual");
  }
}
