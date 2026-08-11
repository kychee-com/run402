import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { resolveEscalationOrg } from "./escalations-shared.js";

/** The wait-for-human loop, plus the raiser's own list. */
export const getEscalationSchema = {
  escalation_id: z
    .string()
    .optional()
    .describe("The escalation to poll. Omit to list your open escalations instead."),
  org_id: z.string().optional().describe("Organization. Defaults to the one resolved from project_id."),
  project_id: z.string().optional().describe("Resolves the organization when org_id is omitted."),
  status: z
    .enum(["open", "acknowledged", "resolved"])
    .optional()
    .describe("Filter the list. Ignored when escalation_id is given."),
  include_delivery: z
    .boolean()
    .optional()
    .describe(
      "Add what ACTUALLY happened per contact and channel, from the delivery audit log. Use when you need to know whether a page landed — not on every poll.",
    ),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleGetEscalation(args: {
  escalation_id?: string;
  org_id?: string;
  project_id?: string;
  status?: "open" | "acknowledged" | "resolved";
  include_delivery?: boolean;
}): Promise<McpResult> {
  const org = await resolveEscalationOrg(args).catch(() => null);
  if (!org || !org.ok) {
    return {
      content: [{ type: "text", text: org ? org.error : "Could not resolve the organization — pass org_id or project_id." }],
      isError: true,
    };
  }
  try {
    const sdk = getSdk();

    if (!args.escalation_id) {
      const page = await sdk.escalations.list(org.orgId, args.status ? { status: args.status } : {});
      if (page.escalations.length === 0) {
        return { content: [{ type: "text", text: "No escalations." }] };
      }
      const lines = page.escalations.map(
        (e) =>
          `${e.escalation_id}  ${e.status.padEnd(12)} L${e.level}  ${e.severity === "high" ? "HIGH " : ""}${e.reason.slice(0, 80)}${e.reason.length > 80 ? "…" : ""}`,
      );
      if (page.has_more) lines.push(`… more (cursor ${page.next_cursor})`);
      lines.push("", `Scope: ${page.scope === "own" ? "escalations you raised" : "the whole organization"}.`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    const esc = await sdk.escalations.get(
      org.orgId,
      args.escalation_id,
      args.include_delivery ? { include: "delivery" } : {},
    );
    const lines = [`${esc.escalation_id} — ${esc.status.toUpperCase()} (level ${esc.level}, ${esc.severity})`, "", esc.reason, ""];

    if (esc.status === "open") {
      lines.push(
        `Nobody has taken it yet. Deadline ${esc.deadline_at} — after that it climbs to the next contact level.`,
        "Keep waiting. Do NOT read silence as approval.",
      );
    } else if (esc.status === "acknowledged") {
      lines.push(
        `Acknowledged by ${esc.acknowledged?.by_email ?? "a human"} at ${esc.acknowledged?.at} (${esc.acknowledged?.channel}).`,
        "A named human owns this now — proceed per their direction, or stand down if they said so.",
      );
    } else {
      lines.push(
        `Resolved by ${esc.resolved?.by_email ?? "a human"} at ${esc.resolved?.at}.`,
        ...(esc.resolved?.note ? [`Note: ${esc.resolved.note}`] : []),
      );
    }

    if (esc.climbs.length > 0) {
      lines.push("", `Climbed ${esc.climbs.length}×: ${esc.climbs.map((c) => `L${c.from_level}→L${c.to_level}`).join(", ")}`);
    }
    if (esc.repage_count > 0) {
      lines.push(`Re-paged the top level ${esc.repage_count}×.`);
    }
    if (esc.delivery_attempts) {
      lines.push("", "Delivery (what actually happened):");
      for (const a of esc.delivery_attempts) {
        lines.push(`  ${a.channel.padEnd(9)} ${a.email.padEnd(28)} ${a.status}${a.error ? ` — ${a.error}` : ""}`);
      }
      if (esc.delivery_attempts.length === 0) lines.push("  (nothing delivered yet)");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "reading an escalation");
  }
}
