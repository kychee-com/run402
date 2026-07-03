import { z } from "zod";

export const listCustomDomainsSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleListCustomDomains(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  return removed(
    `list_custom_domains has been removed. Use domains_list for project ${args.project_id}.`,
  );
}

function removed(text: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}
