import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

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
  try {
    const body = await getSdk().domains.add(args.project_id, args.domain, args.subdomain_name);

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
  } catch (err) {
    return mapSdkError(err, "registering custom domain");
  }
}
