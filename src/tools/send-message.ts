import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const sendMessageSchema = {
  message: z.string().describe("Message to send to the Run402 developers"),
};

export async function handleSendMessage(args: {
  message: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/message/v1");
  if ("error" in auth) return auth.error;

  try {
    await getSdk().admin.sendMessage(args.message);
    return { content: [{ type: "text", text: `Message sent to Run402 developers.` }] };
  } catch (err) {
    return mapSdkError(err, "sending message");
  }
}
