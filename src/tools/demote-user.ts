import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const demoteUserSchema = {
  project_id: z.string().describe("The project ID"),
  email: z.string().describe("Email address of the user to demote from project_admin"),
};

export async function handleDemoteUser(args: {
  project_id: string;
  email: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().auth.demote(args.project_id, args.email);
    return {
      content: [
        {
          type: "text",
          text: `## User Demoted\n\n\`${args.email}\` is no longer a project admin for project \`${args.project_id}\`.\n\nTheir role has been reverted to the default authenticated role.`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "demoting user");
  }
}
