import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const getContractWalletSchema = {
  project_id: z.string().describe("The project ID"),
  wallet_id: z.string().describe("The KMS contract wallet ID (cwlt_...)"),
};

export async function handleGetContractWallet(args: { project_id: string; wallet_id: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().contracts.getWallet(args.project_id, args.wallet_id);
    return { content: [{ type: "text", text: "```json\n" + JSON.stringify(body, null, 2) + "\n```" }] };
  } catch (err) {
    return mapSdkError(err, "fetching wallet");
  }
}
