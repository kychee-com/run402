import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const linkWalletToAccountSchema = {
  billing_account_id: z.string().describe("The billing account ID (from create_email_billing_account)"),
  wallet: z.string().describe("The wallet address to link (0x...)"),
};

export async function handleLinkWalletToAccount(args: {
  billing_account_id: string;
  wallet: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await getSdk().billing.linkWallet(args.billing_account_id, args.wallet);
    const wallet = args.wallet.toLowerCase();
    const lines = [
      `## Wallet Linked`,
      ``,
      `- **Billing account:** \`${args.billing_account_id}\``,
      `- **Wallet:** \`${wallet}\``,
      ``,
      `The account now supports both Stripe checkout and x402 on-chain payments.`,
    ];

    const pool = result?.pool_implications;
    if (pool) {
      const apiPct = pool.tier_limits.api_calls > 0
        ? ((pool.account_api_calls_current / pool.tier_limits.api_calls) * 100).toFixed(1)
        : "—";
      const storagePct = pool.tier_limits.storage_bytes > 0
        ? ((pool.account_storage_bytes_current / pool.tier_limits.storage_bytes) * 100).toFixed(1)
        : "—";
      const storageMb = (pool.account_storage_bytes_current / 1_048_576).toFixed(1);
      const storageLimitMb = (pool.tier_limits.storage_bytes / 1_048_576).toFixed(0);
      lines.push(
        ``,
        `### Account pool after link`,
        ``,
        `Tier and quotas are per billing account. The wallet's spend now`,
        `joins the pool below; every project on this account shares it.`,
        ``,
        `| Field | Value |`,
        `|-------|-------|`,
        `| account tier | ${pool.tier ?? "(no active tier)"} |`,
        `| projects in pool | ${pool.projects_in_pool_count} |`,
        `| api calls | ${pool.account_api_calls_current.toLocaleString()} / ${pool.tier_limits.api_calls.toLocaleString()} (${apiPct}%) |`,
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
