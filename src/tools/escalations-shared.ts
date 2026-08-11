/**
 * Shared organization addressing for the escalation MCP tools.
 *
 * An escalation is org-scoped (it pages the ORG's humans), but an agent almost
 * always knows a project rather than an org id — so a project resolves to its
 * owning org through the same lookup the rooms tools use. Explicit `org_id`
 * wins when the caller has one.
 */
import { getSdk } from "../sdk.js";

export interface EscalationOrgArgs {
  org_id?: string;
  project_id?: string;
}

export type EscalationOrgResult =
  | { ok: true; orgId: string }
  | { ok: false; error: string };

export async function resolveEscalationOrg(args: EscalationOrgArgs): Promise<EscalationOrgResult> {
  const orgId = typeof args.org_id === "string" && args.org_id.length > 0 ? args.org_id : null;
  if (orgId) return { ok: true, orgId };

  const projectId = typeof args.project_id === "string" && args.project_id.length > 0 ? args.project_id : null;
  if (!projectId) {
    return {
      ok: false,
      error:
        "Pass org_id, or project_id so the organization can be resolved from it. An escalation pages an organization's humans, so it needs to know which organization.",
    };
  }
  try {
    const scoped = await getSdk().rooms.forProject(projectId);
    return { ok: true, orgId: scoped.orgId };
  } catch {
    return {
      ok: false,
      error: `Could not resolve an organization from project ${projectId}. Pass org_id explicitly.`,
    };
  }
}
