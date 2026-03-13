import { z } from "zod";
import { apiRequest } from "../client.js";
import { formatApiError } from "../errors.js";

export const sendMessageSchema = {
  message: z.string().describe("Message to send to the Run402 developers"),
};

export async function handleSendMessage(args: {
  message: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const res = await apiRequest("/message/v1", {
    method: "POST",
    body: { message: args.message },
  });

  if (res.is402) {
    return {
      content: [{ type: "text", text: `## Payment Required\n\nSending a message costs $0.01 via x402.\n\n${JSON.stringify(res.body, null, 2)}` }],
    };
  }

  if (!res.ok) return formatApiError(res, "sending message");

  return {
    content: [{ type: "text", text: `Message sent to Run402 developers.` }],
  };
}
