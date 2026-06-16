import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const getSignerSchema = {
  project_id: z.string().describe("The project ID"),
  signer_id: z.string().describe("The KMS signer ID (cwlt_...)"),
};

export async function handleGetSigner(args: { project_id: string; signer_id: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().contracts.getSigner(args.project_id, args.signer_id);
    return { content: [{ type: "text", text: "```json\n" + JSON.stringify(body, null, 2) + "\n```" }] };
  } catch (err) {
    return mapSdkError(err, "fetching signer");
  }
}
