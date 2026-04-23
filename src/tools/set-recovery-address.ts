import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const setRecoveryAddressSchema = {
  project_id: z.string().describe("The project ID"),
  wallet_id: z.string().describe("The KMS contract wallet ID"),
  recovery_address: z.string().nullable().describe("0x-prefixed address (or null to clear). Used for auto-drain on day-90 deletion."),
};

export async function handleSetRecoveryAddress(args: { project_id: string; wallet_id: string; recovery_address: string | null }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().contracts.setRecovery(args.project_id, args.wallet_id, args.recovery_address);
    return { content: [{ type: "text", text: "Recovery address " + (args.recovery_address ? "set to " + args.recovery_address : "cleared") }] };
  } catch (err) {
    return mapSdkError(err, "setting recovery address");
  }
}
