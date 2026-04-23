import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const checkDomainStatusSchema = {
  domain: z.string().describe("The custom domain to check (e.g. 'example.com')"),
  project_id: z.string().describe("The project ID (for authentication)"),
};

export async function handleCheckDomainStatus(args: {
  domain: string;
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().domains.status(args.project_id, args.domain);

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
  } catch (err) {
    return mapSdkError(err, "checking domain status");
  }
}
