import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const removeSenderDomainSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleRemoveSenderDomain(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().senderDomain.remove(args.project_id);
    return {
      content: [{
        type: "text",
        text: `## Sender Domain Removed\n\nCustom sender domain has been removed. Email will now send from \`@mail.run402.com\`.`,
      }],
    };
  } catch (err) {
    return mapSdkError(err, "removing sender domain");
  }
}
