import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const getContractCallStatusSchema = {
  project_id: z.string().describe("The project ID"),
  call_id: z.string().describe("The contract call ID (ccall_...)"),
};

export async function handleGetContractCallStatus(args: { project_id: string; call_id: string }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().contracts.callStatus(args.project_id, args.call_id);
    return { content: [{ type: "text", text: "```json\n" + JSON.stringify(body, null, 2) + "\n```" }] };
  } catch (err) {
    return mapSdkError(err, "fetching call status");
  }
}
