import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const projectUseSchema = {
  project_id: z.string().describe("Project ID to set as active"),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleProjectUse(args: {
  project_id: string;
}): Promise<McpResult> {
  try {
    await getSdk().projects.use(args.project_id);
    return {
      content: [
        {
          type: "text",
          text: `Active project set to \`${args.project_id}\`.`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "setting active project");
  }
}
