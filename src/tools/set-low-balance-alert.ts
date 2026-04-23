import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const setLowBalanceAlertSchema = {
  project_id: z.string().describe("The project ID"),
  wallet_id: z.string().describe("The KMS contract wallet ID"),
  threshold_wei: z.string().describe("Low-balance threshold in wei (decimal string)"),
};

export async function handleSetLowBalanceAlert(args: { project_id: string; wallet_id: string; threshold_wei: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().contracts.setLowBalanceAlert(args.project_id, args.wallet_id, args.threshold_wei);
    return { content: [{ type: "text", text: "Low-balance threshold set to " + args.threshold_wei + " wei" }] };
  } catch (err) {
    return mapSdkError(err, "setting low-balance threshold");
  }
}
