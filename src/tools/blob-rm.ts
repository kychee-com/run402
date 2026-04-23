import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const blobRmSchema = {
  project_id: z.string().describe("Project ID"),
  key: z.string().describe("Blob key to delete"),
};

type Args = { project_id: string; key: string };

export async function handleBlobRm(args: Args): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().blobs.rm(args.project_id, args.key);
    return { content: [{ type: "text", text: `Deleted \`${args.key}\`.` }] };
  } catch (err) {
    return mapSdkError(err, "deleting blob");
  }
}
