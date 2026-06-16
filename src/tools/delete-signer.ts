import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const deleteSignerSchema = {
  project_id: z.string().describe("The project ID"),
  signer_id: z.string().describe("The KMS signer ID. Schedules KMS key deletion (7-day window). Refused if balance >= dust — drain first."),
};

export async function handleDeleteSigner(args: { project_id: string; signer_id: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().contracts.deleteSigner(args.project_id, args.signer_id);
    return { content: [{ type: "text", text: "## Signer Deleted\n\n```json\n" + JSON.stringify(body, null, 2) + "\n```" }] };
  } catch (err) {
    return mapSdkError(err, "deleting signer");
  }
}
