import { getSdk } from "../sdk.js";
import { noWalletHint } from "../tool-profiles.js";

export const walletExportSchema = {};

export async function handleWalletExport(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const address = await getSdk().wallets.export();
    return { content: [{ type: "text", text: address }] };
  } catch {
    return {
      content: [
        {
          type: "text",
          text: noWalletHint(),
        },
      ],
      isError: true,
    };
  }
}
