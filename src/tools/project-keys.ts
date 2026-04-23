import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const projectKeysSchema = {
  project_id: z.string().describe("Project ID to get keys for"),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleProjectKeys(args: {
  project_id: string;
}): Promise<McpResult> {
  try {
    const keys = await getSdk().projects.keys(args.project_id);

    const lines = [
      `## Project Keys: ${args.project_id}`,
      ``,
      `| Key | Value |`,
      `|-----|-------|`,
      `| anon_key | \`${keys.anon_key}\` |`,
      `| service_key | \`${keys.service_key}\` |`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "fetching project keys");
  }
}
