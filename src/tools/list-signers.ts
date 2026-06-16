import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const listSignersSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleListSigners(args: { project_id: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().contracts.listSigners(args.project_id);
    return { content: [{ type: "text", text: "```json\n" + JSON.stringify(body, null, 2) + "\n```" }] };
  } catch (err) {
    return mapSdkError(err, "listing signers");
  }
}
