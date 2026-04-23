import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const promoteUserSchema = {
  project_id: z.string().describe("The project ID"),
  email: z.string().describe("Email address of the user to promote to project_admin"),
};

export async function handlePromoteUser(args: {
  project_id: string;
  email: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().auth.promote(args.project_id, args.email);
    return {
      content: [
        {
          type: "text",
          text: `## User Promoted\n\n\`${args.email}\` is now a project admin for project \`${args.project_id}\`.\n\nThey can manage secrets from the browser using the \`project_admin\` role.`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "promoting user");
  }
}
