import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const drainSignerSchema = {
  project_id: z.string().describe("The project ID"),
  signer_id: z.string().describe("The KMS signer ID"),
  destination_address: z.string().describe("Where to send the entire native-token balance. Cost: chain gas + $0.000005 KMS sign fee. Works on suspended signers."),
};

export async function handleDrainSigner(args: { project_id: string; signer_id: string; destination_address: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().contracts.drain(args.project_id, args.signer_id, args.destination_address);
    return { content: [{ type: "text", text: "## Drain Submitted\n\n```json\n" + JSON.stringify(body, null, 2) + "\n```" }] };
  } catch (err) {
    return mapSdkError(err, "draining signer");
  }
}
