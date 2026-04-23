import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const removeCustomDomainSchema = {
  domain: z.string().describe("The custom domain to release (e.g. 'example.com')"),
  project_id: z
    .string()
    .optional()
    .describe("Optional project ID for ownership verification"),
};

export async function handleRemoveCustomDomain(args: {
  domain: string;
  project_id?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().domains.remove(args.domain, { projectId: args.project_id });
    return {
      content: [
        {
          type: "text",
          text: `## Custom Domain Removed\n\nDomain \`${args.domain}\` has been released. Traffic to this domain will no longer be routed to Run402.`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "removing custom domain");
  }
}
