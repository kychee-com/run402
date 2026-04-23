import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const pinProjectSchema = {
  project_id: z.string().describe("The project ID to pin"),
};

export async function handlePinProject(
  args: { project_id: string },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().projects.pin(args.project_id);
    return {
      content: [
        {
          type: "text",
          text: `Project \`${args.project_id}\` pinned successfully.${body.message ? ` ${body.message}` : ""}`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "pinning project");
  }
}
