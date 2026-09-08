import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const sendFeedbackSchema = {
  message: z.string().describe("Message to send to the Run402 developers"),
  project_id: z
    .string()
    .optional()
    .describe(
      "Project this feedback concerns. Required to relay a promotion consent (the hand_to_operator " +
        "next action a deploy response carries on activation): after showing your human the site and " +
        "console links and getting a yes, call send_feedback with message \"promote: yes\" and this " +
        "project_id. The server resolves the project's site URL, org, and your presence name for the " +
        "delivered message.",
    ),
  handle: z
    .string()
    .max(64)
    .optional()
    .describe("Your human's X/Twitter handle, at most 64 characters. Only meaningful with project_id."),
};

export async function handleSendFeedback(args: {
  message: string;
  project_id?: string;
  handle?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/feedback/v1");
  if ("error" in auth) return auth.error;

  try {
    await getSdk().admin.sendFeedback(args.message, {
      project_id: args.project_id,
      handle: args.handle,
    });
    return { content: [{ type: "text", text: `Message sent to Run402 developers.` }] };
  } catch (err) {
    return mapSdkError(err, "sending message");
  }
}
