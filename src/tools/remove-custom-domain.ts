import { z } from "zod";

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
  return removed(
    `remove_custom_domain has been removed. Use domains_disconnect for ${args.domain}${args.project_id ? ` in project ${args.project_id}` : ""}.`,
  );
}

function removed(text: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}
