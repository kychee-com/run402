import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const deleteVersionSchema = {
  project_id: z.string().describe("The project ID"),
  version_id: z.string().describe("The version ID to delete"),
};

export async function handleDeleteVersion(args: {
  project_id: string;
  version_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().apps.deleteVersion(args.project_id, args.version_id);
    return { content: [{ type: "text", text: `Version \`${args.version_id}\` deleted.` }] };
  } catch (err) {
    return mapSdkError(err, "deleting version");
  }
}
