import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const getDeploymentSchema = {
  deployment_id: z.string().describe("Deployment ID (e.g. dpl_1709337600000_a1b2c3)"),
};

export async function handleGetDeployment(args: {
  deployment_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().sites.getDeployment(args.deployment_id);

    const lines = [
      `## Deployment: ${body.id}`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| name | ${body.name} |`,
      `| url | ${body.url} |`,
      `| status | ${body.status} |`,
      `| files | ${body.files_count} |`,
      `| size | ${body.total_size} bytes |`,
    ];

    if (body.project_id) {
      lines.push(`| project | \`${body.project_id}\` |`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "fetching deployment");
  }
}
