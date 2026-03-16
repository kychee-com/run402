import { z } from "zod";
import { readWallet } from "../wallet.js";
import { getWalletPath } from "../config.js";

export const walletExportSchema = {};

export async function handleWalletExport(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const wallet = readWallet();

  if (!wallet) {
    return {
      content: [
        {
          type: "text",
          text: "No wallet found. Use `wallet_create` to create one.",
        },
      ],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: wallet.address }],
  };
}
