import { z } from "zod";

export const addCustomDomainSchema = {
  domain: z
    .string()
    .describe("The custom domain to register (e.g. 'example.com' or 'docs.example.com')"),
  subdomain_name: z
    .string()
    .describe("The Run402 subdomain to map this domain to (e.g. 'myapp' for myapp.run402.com)"),
  project_id: z
    .string()
    .describe("The project ID that owns the subdomain"),
};

export async function handleAddCustomDomain(args: {
  domain: string;
  subdomain_name: string;
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  return removed(
    `add_custom_domain has been removed. Use domains_ensure with desired.web for ${args.domain} in project ${args.project_id}.`,
  );
}

function removed(text: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}
