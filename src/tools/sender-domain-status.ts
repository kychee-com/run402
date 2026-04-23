import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const senderDomainStatusSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleSenderDomainStatus(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().senderDomain.status(args.project_id);

    if (!body.domain) {
      return { content: [{ type: "text", text: "## No Sender Domain\n\nNo custom sender domain registered. Email sends from `@mail.run402.com`. Use `register_sender_domain` to set up a custom domain." }] };
    }

    return {
      content: [{
        type: "text",
        text: `## Sender Domain Status\n\n- **Domain:** ${body.domain}\n- **Status:** ${body.status}\n${body.verified_at ? `- **Verified:** ${body.verified_at}\n` : ""}\n${body.status === "pending" ? "Add the DKIM CNAME records to your DNS and check again. Verification usually takes a few minutes." : "Domain is verified. All outbound email sends from this domain."}`,
      }],
    };
  } catch (err) {
    return mapSdkError(err, "checking sender domain status");
  }
}
