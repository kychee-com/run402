import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { resolveEscalationOrg } from "./escalations-shared.js";

/**
 * The tool description IS the product here. The gateway cannot judge when a
 * human is needed — the model does — so the doctrine has to live where the
 * model reads it, not only in docs a model may never open.
 */
export const raiseEscalationSchema = {
  reason: z
    .string()
    .describe(
      "YOUR argument for why a human is needed, in your own words. State what you observed, what the conflict or risk is, and whether you have proceeded. This is what a person reads on their phone — it is the whole escalation. Over ~4 KiB is rejected, never truncated.",
    ),
  severity: z
    .enum(["normal", "high"])
    .optional()
    .describe("high marks it urgent in the page subject. Use sparingly, or it stops meaning anything."),
  project_id: z
    .string()
    .optional()
    .describe("The project this concerns. Also resolves the organization when org_id is omitted."),
  org_id: z.string().optional().describe("Organization to page. Defaults to the active project's org."),
  presence_name: z
    .string()
    .optional()
    .describe("Your coordination-room presence name, so the human knows which agent is calling."),
  idempotency_key: z
    .string()
    .optional()
    .describe("Safe-retry key: a replay returns the ORIGINAL escalation and never pages twice."),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleRaiseEscalation(args: {
  reason: string;
  severity?: "normal" | "high";
  project_id?: string;
  org_id?: string;
  presence_name?: string;
  idempotency_key?: string;
}): Promise<McpResult> {
  const org = await resolveEscalationOrg(args).catch(() => null);
  if (!org || !org.ok) {
    return {
      content: [{ type: "text", text: org ? org.error : "Could not resolve the organization — pass org_id or project_id." }],
      isError: true,
    };
  }
  try {
    const raised = await getSdk().escalations.raise(org.orgId, {
      reason: args.reason,
      ...(args.severity ? { severity: args.severity } : {}),
      ...(args.project_id ? { projectId: args.project_id } : {}),
      ...(args.presence_name ? { presenceName: args.presence_name } : {}),
      ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
    });

    const willPage = raised.delivery?.will_page ?? [];
    const lines = [
      raised.deduplicated
        ? `Already raised — this is the ORIGINAL escalation (${raised.escalation_id}), not a second page.`
        : `Raised ${raised.escalation_id} (${raised.severity}).`,
      // Faithful: queued is not delivered, and the wording must not blur that.
      willPage.length > 0
        ? `Paging ${willPage.length} contact(s) at level ${raised.delivery?.level}: ${willPage.map((c) => c.email).join(", ")}. The page is queued; delivery happens on the next worker tick.`
        : "No contacts are configured at this level, so nobody was paged.",
      `Deadline ${raised.delivery?.deadline_at ?? "—"}: if nobody acknowledges by then, it climbs to the next contact level.`,
      "",
      `Now WAIT: poll get_escalation(escalation_id: "${raised.escalation_id}") until status is "acknowledged" — that means a NAMED human owns it. Then proceed per their direction, or stand down. Silence is not consent.`,
    ];
    for (const w of raised.warnings ?? []) lines.push(`WARNING: ${w}`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "raising an escalation");
  }
}
