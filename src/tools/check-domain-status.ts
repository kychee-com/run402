import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const checkDomainStatusSchema = {
  domain: z.string().describe("The custom domain to check (e.g. 'example.com')"),
  project_id: z.string().describe("The project ID (for authentication)"),
};

export async function handleCheckDomainStatus(args: {
  domain: string;
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/domains/v1/${encodeURIComponent(args.domain)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
  });

  if (!res.ok) return formatApiError(res, "checking domain status");

  const body = res.body as {
    domain: string;
    subdomain_name: string;
    url: string;
    subdomain_url: string;
    status: string;
    dns_instructions: { cname_target?: string; txt_name?: string; txt_value?: string } | null;
    created_at: string;
  };

  const lines = [
    `## Domain Status`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| domain | \`${body.domain}\` |`,
    `| url | ${body.url} |`,
    `| subdomain | ${body.subdomain_url} |`,
    `| status | **${body.status}** |`,
  ];

  if (body.status === "active") {
    lines.push(``, `The domain is live at **${body.url}**`);
  } else if (body.dns_instructions) {
    const dns = body.dns_instructions;
    lines.push(
      ``,
      `## DNS Configuration Required`,
      ``,
      `The domain is still pending. Ensure these DNS records are set:`,
    );
    if (dns.cname_target) {
      lines.push(`- **CNAME**: \`${body.domain}\` → \`${dns.cname_target}\``);
    }
    if (dns.txt_name && dns.txt_value) {
      lines.push(`- **TXT**: \`${dns.txt_name}\` → \`${dns.txt_value}\``);
    }
    lines.push(``, `DNS propagation may take up to 60 seconds. Check again shortly.`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
