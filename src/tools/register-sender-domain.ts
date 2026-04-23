import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const registerSenderDomainSchema = {
  project_id: z.string().describe("The project ID"),
  domain: z.string().describe("The domain to register for email sending (e.g., 'kysigned.com')"),
};

export async function handleRegisterSenderDomain(args: {
  project_id: string;
  domain: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().senderDomain.register(args.project_id, args.domain);
    const dnsTable = body.dns_records.map((r) => `| ${r.type} | \`${r.name}\` | \`${r.value}\` |`).join("\n");

    return {
      content: [{
        type: "text",
        text: `## Sender Domain Registered\n\n- **Domain:** ${body.domain}\n- **Status:** ${body.status}\n\n### DNS Records to Add\n\n| Type | Name | Value |\n|------|------|-------|\n${dnsTable}\n\n${body.instructions}`,
      }],
    };
  } catch (err) {
    return mapSdkError(err, "registering sender domain");
  }
}
