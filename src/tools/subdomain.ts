import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const claimSubdomainSchema = {
  name: z
    .string()
    .describe("Custom subdomain name (e.g. 'myapp' → myapp.run402.com). 3-63 chars, lowercase alphanumeric + hyphens."),
  deployment_id: z
    .string()
    .describe("Deployment ID to point this subdomain at (e.g. 'dpl_1709337600000_a1b2c3')"),
  project_id: z
    .string()
    .optional()
    .describe("Optional project ID for ownership tracking. Uses stored service_key for auth."),
};

export async function handleClaimSubdomain(args: {
  name: string;
  deployment_id: string;
  project_id?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().subdomains.claim(args.name, args.deployment_id, {
      projectId: args.project_id,
    });

    const lines = [
      `## Subdomain Claimed`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| subdomain | \`${body.name}\` |`,
      `| url | ${body.url} |`,
      `| deployment | \`${body.deployment_id}\` |`,
      `| deployment_url | ${body.deployment_url} |`,
      ``,
      `The site is now live at **${body.url}**`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "claiming subdomain");
  }
}

export const deleteSubdomainSchema = {
  name: z
    .string()
    .describe("Subdomain name to release (e.g. 'myapp')"),
  project_id: z
    .string()
    .optional()
    .describe("Optional project ID for ownership verification. Uses stored service_key for auth."),
};

export async function handleDeleteSubdomain(args: {
  name: string;
  project_id?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().subdomains.delete(args.name, { projectId: args.project_id });
    return {
      content: [{ type: "text", text: `## Subdomain Released\n\nSubdomain \`${args.name}\` has been deleted. The URL \`https://${args.name}.run402.com\` is no longer active.` }],
    };
  } catch (err) {
    return mapSdkError(err, "deleting subdomain");
  }
}
