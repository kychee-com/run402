import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";
import { formatAgentContact } from "./set-agent-contact.js";

export const getAgentContactStatusSchema = {};

export async function handleGetAgentContactStatus(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/agent/v1/contact/status");
  if ("error" in auth) return auth.error;

  try {
    const result = await getSdk().admin.getAgentContactStatus();
    return { content: [{ type: "text", text: formatAgentContact("Agent Contact Status", result) }] };
  } catch (err) {
    return mapSdkError(err, "fetching agent contact status");
  }
}
