import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { noWalletHint } from "../tool-profiles.js";

export const walletStatusSchema = {};

export async function handleWalletStatus(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const localWallet = await getSdk().wallets.status();

    if (!localWallet.configured) {
      return {
        content: [
          {
            type: "text",
            text: noWalletHint(),
          },
        ],
      };
    }

    const lines = [
      `## Agent Wallet Status`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| address | \`${localWallet.address}\` |`,
      `| created | ${localWallet.created || "unknown"} |`,
      `| faucet_used | ${localWallet.faucet_used ? "yes" : "no"} |`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "reading wallet status");
  }
}
