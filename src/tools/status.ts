/**
 * `status` — the organization's state as the active wallet sees it: `r.status()`.
 *
 * The local view (which wallet this server acts as, its `local_label`,
 * `server_label`, and address, the active project) combined with the reads
 * that wallet can make (tier and lease, allowance, projects). It never returns
 * key material. Every other operation is a `run` snippet against `r`.
 */

import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { jsonBlock, okResult, type ToolResult } from "../structured.js";


export const statusSchema = {};

export async function handleStatus(): Promise<ToolResult> {
  try {
    const status = await getSdk().status();
    const lines: string[] = [];
    if (status.wallet === null) {
      lines.push("## Status: no local wallet", "", status.hint);
    } else {
      const tier = status.tier ? `${status.tier.name} (${status.tier.status}${status.tier.expires ? `, lease until ${status.tier.expires}` : ""})` : "none";
      lines.push(
        `## Status: wallet ${status.wallet.local_label} (${status.wallet.address})`,
        "",
        `- tier: ${tier}`,
        `- active project: ${status.active_project ?? "none"}`,
        `- projects: ${status.projects.length}`,
      );
    }
    const structured = okResult(status);
    lines.push("", jsonBlock(structured));
    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: structured };
  } catch (err) {
    return mapSdkError(err, "reading status");
  }
}
