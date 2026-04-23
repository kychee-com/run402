import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const updateVersionSchema = {
  project_id: z.string().describe("The project ID"),
  version_id: z.string().describe("The version ID to update"),
  description: z.string().optional().describe("Updated description"),
  tags: z.array(z.string()).optional().describe("Updated tags"),
  visibility: z.enum(["public", "unlisted", "private"]).optional().describe("Updated visibility"),
  fork_allowed: z.boolean().optional().describe("Whether forking is allowed"),
};

export async function handleUpdateVersion(args: {
  project_id: string;
  version_id: string;
  description?: string;
  tags?: string[];
  visibility?: string;
  fork_allowed?: boolean;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().apps.updateVersion(args.project_id, args.version_id, {
      description: args.description,
      tags: args.tags,
      visibility: args.visibility as "public" | "unlisted" | "private" | undefined,
      fork_allowed: args.fork_allowed,
    });
    return { content: [{ type: "text", text: `Version \`${args.version_id}\` updated.` }] };
  } catch (err) {
    return mapSdkError(err, "updating version");
  }
}
