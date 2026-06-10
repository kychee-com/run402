import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const renameProjectSchema = {
  project_id: z.string().describe("The project ID to rename (prefix: prj_)."),
  name: z
    .string()
    .describe("New display name (1-200 characters, no control characters; server-validated)."),
};

export async function handleRenameProject(args: {
  project_id: string;
  name: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await getSdk().projects.rename(args.project_id, args.name);
    return {
      content: [
        {
          type: "text",
          text: `Project \`${result.project_id}\` renamed to "${result.name}".`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "renaming project");
  }
}
