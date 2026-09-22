import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireWalletAuth } from "../wallet-auth.js";
import { formatAgentContact } from "./set-agent-contact.js";

export const startContactPasskeyEnrollmentSchema = {};

export async function handleStartContactPasskeyEnrollment(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireWalletAuth("/agent/v1/contact/passkey/enroll");
  if ("error" in auth) return auth.error;

  try {
    const result = await getSdk().admin.startContactPasskeyEnrollment();
    return { content: [{ type: "text", text: formatAgentContact("Contact Passkey Enrollment Sent", result) }] };
  } catch (err) {
    return mapSdkError(err, "starting contact passkey enrollment");
  }
}
