import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const disableInboundSchema = {
  project_id: z.string().describe("The project ID"),
  domain: z.string().describe("The custom sender domain to disable inbound on"),
};

export async function handleDisableInbound(args: {
  project_id: string;
  domain: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().senderDomain.disableInbound(args.project_id, args.domain);
    return {
      content: [{
        type: "text",
        text: `Inbound email disabled on \`${args.domain}\`. Replies to this domain will no longer be delivered through run402.`,
      }],
    };
  } catch (err) {
    return mapSdkError(err, "disabling inbound email");
  }
}
