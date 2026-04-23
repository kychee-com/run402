import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const listSubdomainsSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleListSubdomains(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const subdomains = await getSdk().subdomains.list(args.project_id);

    if (subdomains.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `## Subdomains\n\n_No subdomains claimed. Use \`claim_subdomain\` to claim one._`,
          },
        ],
      };
    }

    const lines = [
      `## Subdomains (${subdomains.length})`,
      ``,
      `| Subdomain | URL | Deployment |`,
      `|-----------|-----|------------|`,
    ];

    for (const s of subdomains) {
      lines.push(`| ${s.name} | ${s.url} | \`${s.deployment_id}\` |`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing subdomains");
  }
}
