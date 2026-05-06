import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";
import { formatAgentContact } from "./set-agent-contact.js";

export const verifyAgentContactEmailSchema = {};

export async function handleVerifyAgentContactEmail(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/agent/v1/contact/verify-email");
  if ("error" in auth) return auth.error;

  try {
    const result = await getSdk().admin.verifyAgentContactEmail();
    return { content: [{ type: "text", text: formatAgentContact("Agent Contact Email Verification", result) }] };
  } catch (err) {
    return mapSdkError(err, "starting agent contact email verification");
  }
}
