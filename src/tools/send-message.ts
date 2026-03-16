import { z } from "zod";
import { apiRequest } from "../client.js";
import { formatApiError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const sendMessageSchema = {
  message: z.string().describe("Message to send to the Run402 developers"),
};

export async function handleSendMessage(args: {
  message: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth();
  if ("error" in auth) return auth.error;

  const res = await apiRequest("/message/v1", {
    method: "POST",
    headers: { ...auth.headers },
    body: { message: args.message },
  });

  if (!res.ok) return formatApiError(res, "sending message");

  return {
    content: [{ type: "text", text: `Message sent to Run402 developers.` }],
  };
}
