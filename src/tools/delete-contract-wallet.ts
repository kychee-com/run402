import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const deleteContractWalletSchema = {
  project_id: z.string().describe("The project ID"),
  wallet_id: z.string().describe("The KMS contract wallet ID. Schedules KMS key deletion (7-day window). Refused if balance >= dust — drain first."),
};

export async function handleDeleteContractWallet(args: { project_id: string; wallet_id: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().contracts.deleteWallet(args.project_id, args.wallet_id);
    return { content: [{ type: "text", text: "## Wallet Deleted\n\n```json\n" + JSON.stringify(body, null, 2) + "\n```" }] };
  } catch (err) {
    return mapSdkError(err, "deleting wallet");
  }
}
