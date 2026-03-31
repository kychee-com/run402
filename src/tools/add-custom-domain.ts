import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

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
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest("/domains/v1", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
    body: { domain: args.domain, subdomain_name: args.subdomain_name },
  });

  if (!res.ok) return formatApiError(res, "registering custom domain");

  const body = res.body as {
    domain: string;
    subdomain_name: string;
    url: string;
    subdomain_url: string;
    status: string;
    dns_instructions: { cname_target?: string; txt_name?: string; txt_value?: string } | null;
    project_id: string | null;
    created_at: string;
  };

  const lines = [
    `## Custom Domain Registered`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| domain | \`${body.domain}\` |`,
    `| url | ${body.url} |`,
    `| subdomain | ${body.subdomain_url} |`,
    `| status | ${body.status} |`,
  ];

  if (body.dns_instructions) {
    const dns = body.dns_instructions;
    lines.push(
      ``,
      `## DNS Configuration Required`,
      ``,
      `Add the following DNS records at your domain registrar:`,
    );
    if (dns.cname_target) {
      lines.push(`- **CNAME**: \`${body.domain}\` → \`${dns.cname_target}\``);
    }
    if (dns.txt_name && dns.txt_value) {
      lines.push(`- **TXT**: \`${dns.txt_name}\` → \`${dns.txt_value}\``);
    }
    lines.push(
      ``,
      `After DNS propagates (up to 60 seconds), check status with \`check_domain_status\`.`,
    );
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
