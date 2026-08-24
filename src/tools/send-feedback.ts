import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const sendFeedbackSchema = {
  message: z.string().describe("Message to send to the Run402 developers"),
};

export async function handleSendFeedback(args: {
  message: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/feedback/v1");
  if ("error" in auth) return auth.error;

  try {
    await getSdk().admin.sendFeedback(args.message);
    return { content: [{ type: "text", text: `Message sent to Run402 developers.` }] };
  } catch (err) {
    return mapSdkError(err, "sending message");
  }
}
