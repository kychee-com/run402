import { z } from "zod";

export const checkDomainStatusSchema = {
  domain: z.string().describe("The custom domain to check (e.g. 'example.com')"),
  project_id: z.string().describe("The project ID (for authentication)"),
};

export async function handleCheckDomainStatus(args: {
  domain: string;
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  return removed(
    `check_domain_status has been removed. Use domains_check for ${args.domain} in project ${args.project_id}.`,
  );
}

function removed(text: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}
