import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const deleteProjectSchema = {
  project_id: z
    .string()
    .describe("The project ID to delete (irreversible cascade purge)"),
};

export async function handleDeleteProject(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().projects.delete(args.project_id);
    return {
      content: [
        {
          type: "text",
          text: `Project \`${args.project_id}\` deleted (status: purged). Schema dropped, functions deleted, subdomains released, mailbox tombstoned. Removed from local key store. This action is irreversible.`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "deleting project");
  }
}
