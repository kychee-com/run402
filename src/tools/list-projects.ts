import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const listProjectsSchema = {
  org_id: z
    .string()
    .optional()
    .describe(
      "Optional org (organization) id to filter to. Authorize-before-reveal: a non-member or guessed id returns the same 403 as a real-but-unauthorized org; a non-UUID id is a 400.",
    ),
  all: z
    .boolean()
    .optional()
    .describe(
      "Read the cross-wallet inventory across every wallet controlling your operator email instead of just this wallet's membership-scoped slice. Mutually exclusive with org_id.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Page size for the membership-scoped read (server default 50, max 200)."),
  cursor: z
    .string()
    .optional()
    .describe("Pagination cursor from a previous response's next_cursor."),
};

export async function handleListProjects(args: {
  org_id?: string;
  all?: boolean;
  limit?: number;
  cursor?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().projects.list({
      ...(args.org_id !== undefined ? { org: args.org_id } : {}),
      ...(args.all ? { all: true } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    });

    const scopeLabel = args.all
      ? `cross-wallet inventory${body.scope ? ` (scope: ${body.scope})` : ""}`
      : args.org_id
        ? `org ${args.org_id}`
        : "your projects";

    if (body.projects.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `## Projects — ${scopeLabel}\n\n_No projects found._`,
          },
        ],
      };
    }

    const lines = [
      `## Projects — ${scopeLabel} (${body.projects.length})`,
      ``,
      `Tier and lifecycle live on the organization, not each project.`,
      `Call \`tier_status\` for the organization tier, lifecycle state, and pooled`,
      `usage across every project below.`,
      ``,
      `| ID | Name | Site URL | Custom domains | Org (organization_id) | Status |`,
      `|----|------|----------|----------------|--------------------------|--------|`,
    ];

    for (const p of body.projects) {
      const domains =
        p.custom_domains && p.custom_domains.length ? p.custom_domains.join(", ") : "—";
      lines.push(
        `| \`${p.id}\` | ${p.name ?? "—"} | ${p.site_url ?? "—"} | ${domains} | ${p.organization_id ?? "—"} | ${p.status ?? p.effective_status ?? "—"} |`,
      );
    }

    if (body.has_more && body.next_cursor) {
      lines.push(``, `_More results — pass \`cursor: "${body.next_cursor}"\` to fetch the next page._`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing projects");
  }
}
