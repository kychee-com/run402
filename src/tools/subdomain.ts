import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const addSubdomainSchema = {
  name: z
    .string()
    .describe("Custom subdomain name (e.g. 'myapp' → myapp.run402.com). 3-63 chars, lowercase alphanumeric + hyphens."),
  deployment_id: z
    .string()
    .optional()
    .describe("Optional target: a legacy deployment ID (dpl_...) or a rel_.../op_... id. Omit both this and release_id to bind the project's live (active) release."),
  release_id: z
    .string()
    .optional()
    .describe("Optional release ID (rel_...) to point this subdomain at. Omit both this and deployment_id to bind the project's live (active) release."),
  project_id: z
    .string()
    .optional()
    .describe("Optional project ID for ownership tracking. Uses stored service_key for auth."),
};

export async function handleAddSubdomain(args: {
  name: string;
  deployment_id?: string;
  release_id?: string;
  project_id?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().subdomains.add({
      name: args.name,
      deploymentId: args.deployment_id,
      releaseId: args.release_id,
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
    return mapSdkError(err, "adding subdomain");
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
