import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const listCustomDomainsSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleListCustomDomains(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().domains.list(args.project_id);
    const domains = body.domains;

    if (domains.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `## Custom Domains\n\n_No custom domains registered. Use \`add_custom_domain\` to register one._`,
          },
        ],
      };
    }

    const lines = [
      `## Custom Domains (${domains.length})`,
      ``,
      `| Domain | Subdomain | Status | Created |`,
      `|--------|-----------|--------|---------|`,
    ];

    for (const d of domains) {
      lines.push(`| ${d.domain} | ${d.subdomain_url} | ${d.status} | ${d.created_at} |`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing custom domains");
  }
}
