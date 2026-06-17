import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const linkWalletToOrganizationSchema = {
  org_id: z.string().describe("The organization ID (from create_email_organization)"),
  wallet: z.string().describe("The wallet address to link (0x...)"),
};

export async function handleLinkWalletToOrganization(args: {
  org_id: string;
  wallet: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await getSdk().billing.linkWallet(args.org_id, args.wallet);
    const wallet = args.wallet.toLowerCase();
    const lines = [
      `## Wallet Linked`,
      ``,
      `- **Organization:** \`${args.org_id}\``,
      `- **Wallet:** \`${wallet}\``,
      ``,
      `The organization now supports both Stripe checkout and x402 on-chain payments.`,
    ];

    const pool = result?.pool_implications;
    if (pool) {
      const apiPct = pool.tier_limits.api_calls > 0
        ? ((pool.organization_api_calls_current / pool.tier_limits.api_calls) * 100).toFixed(1)
        : "—";
      const storagePct = pool.tier_limits.storage_bytes > 0
        ? ((pool.organization_storage_bytes_current / pool.tier_limits.storage_bytes) * 100).toFixed(1)
        : "—";
      const storageMb = (pool.organization_storage_bytes_current / 1_048_576).toFixed(1);
      const storageLimitMb = (pool.tier_limits.storage_bytes / 1_048_576).toFixed(0);
      lines.push(
        ``,
        `### Organization pool after link`,
        ``,
        `Tier and quotas are per organization. The wallet's spend now`,
        `joins the pool below; every project in this organization shares it.`,
        ``,
        `| Field | Value |`,
        `|-------|-------|`,
        `| organization tier | ${pool.tier ?? "(no active tier)"} |`,
        `| projects in pool | ${pool.projects_in_pool_count} |`,
        `| api calls | ${pool.organization_api_calls_current.toLocaleString()} / ${pool.tier_limits.api_calls.toLocaleString()} (${apiPct}%) |`,
        `| storage | ${storageMb} MB / ${storageLimitMb} MB (${storagePct}%) |`,
        `| over limit | ${pool.over_limit ? "**yes — pool is over the tier cap; renew or upgrade**" : "no"} |`,
      );
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  } catch (err) {
    return mapSdkError(err, "linking wallet");
  }
}
