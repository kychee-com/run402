import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const enableInboundSchema = {
  project_id: z.string().describe("The project ID"),
  domain: z.string().describe("The custom sender domain to enable inbound on (must be DKIM-verified)"),
};

export async function handleEnableInbound(args: {
  project_id: string;
  domain: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().senderDomain.enableInbound(args.project_id, args.domain);

    const lines = [
      `## Inbound email enabled on \`${args.domain}\``,
      ``,
      `- **Status:** ${body.status}`,
      body.mx_record ? `- **MX record to add:** \`${body.mx_record}\`` : "",
      ``,
      `Add the MX record to your DNS provider. Replies to \`<slug>@${args.domain}\` will route through run402's inbound pipeline.`,
    ].filter(Boolean);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "enabling inbound email");
  }
}
