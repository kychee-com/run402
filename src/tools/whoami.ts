/**
 * `whoami` — the REMOTE identity: `r.orgs.whoami()`.
 *
 * The control-plane principal this server's wallet resolves to, its active
 * authenticator and linked identities, its org memberships, and the grade of
 * the sign-in session that authenticated the read (none for a wallet). For the
 * LOCAL wallet state use `status`; to change the display name, run
 * `await r.orgs.setDisplayName(name)` with `run`.
 */

import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { formatLinkedIdentity } from "../identity-format.js";
import { jsonBlock, okResult, type ToolResult } from "../structured.js";


export const whoamiSchema = {};

export async function handleWhoami(): Promise<ToolResult> {
  try {
    const me = await getSdk().orgs.whoami();
    const structured = okResult(me);
    const lines = [
      `## Principal \`${me.principal.id}\` (${me.principal.type}${me.principal.display_name ? `, ${me.principal.display_name}` : ""})`,
      "",
      `- active_authenticator: ${me.active_authenticator ? `${me.active_authenticator.kind} \`${me.active_authenticator.public_subject}\`` : "none"}`,
      `- linked_identities: ${(me.linked_identities ?? []).length > 0 ? me.linked_identities.map(formatLinkedIdentity).join(", ") : "none"}`,
      `- memberships: ${me.memberships.length > 0 ? me.memberships.map((m) => `\`${m.org_id}\`${m.display_name ? ` ("${m.display_name}")` : ""} ${m.role} (${m.status})`).join("; ") : "none"}`,
      `- session: ${me.session ? `${me.session.grade}${me.session.grade === "device" ? " (read-only)" : ""}` : "none (wallet)"}`,
      "",
      jsonBlock(structured),
    ];
    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: structured };
  } catch (err) {
    return mapSdkError(err, "resolving principal identity");
  }
}
