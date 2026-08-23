/**
 * Shared organization resolution for org-scoped CLI families
 * (attention-architecture Wave E — one resolver, not one per family).
 *
 * Precedence: explicit `--org` flag → `RUN402_ORG` env → the active project's
 * owning org (the zero-config checkout path, one SDK lookup). Every org-scoped
 * family (`escalations`, and whatever ships next) resolves through here so a
 * checkout needs no flags and the precedence cannot drift per family.
 *
 * `rooms`/`claims` predate this and resolve a PAIR ({orgId, roomKey}) with
 * their own `RUN402_ROOM` env form — see `rooms-context.mjs`; forcing them
 * through a single-value resolver would contort both. One resolver per SHAPE.
 */
import { getSdk } from "./sdk.mjs";
import { flagValue } from "./argparse.mjs";
import { getProject, resolveProjectId, updateProject } from "./config.mjs";

/** Resolve the addressed organization from normalized argv (one SDK lookup at most). */
export async function resolveOrgId(a) {
  const explicit = flagValue(a, "--org");
  if (explicit) return explicit;
  const envOrg = (process.env.RUN402_ORG ?? "").trim();
  if (envOrg) return envOrg;
  const projectId = resolveProjectId(flagValue(a, "--project"));
  const scoped = await getSdk().rooms.forProject(projectId);
  return scoped.orgId;
}

/**
 * The organization that OWNS a specific project, or `null`.
 *
 * Distinct from {@link resolveOrgId}: that one answers "which org is this
 * command addressed at" (flag → env → active project); this one answers "who
 * owns THIS project id", which is what a project-scoped scaffold needs and
 * where an `--org` override would be a mis-binding, not a convenience.
 *
 * WHY IT CACHES (task 5.12c): the gitvault scaffold is the one part of
 * `run402 init` the client-surface spec says adds no network dependency to the
 * cold-start path, and resolving the org through `projects.list()` quietly made
 * that untrue. `org_id` is a non-secret routing identifier the control plane
 * already hands back with every listing, so the honest fix is to remember it —
 * the FIRST call on a machine still asks, every returning one reads it locally.
 *
 * Cached in the local project entry after the first lookup, and an EXACT id
 * match is required: a near-miss must never bind a vault or a git remote to
 * somebody else's project. `updateProject` is a no-op for a project this
 * machine holds no credentials for, so such a project asks again next time
 * rather than being silently mis-cached. Returns `null` rather than throwing —
 * every caller has something better to say than a stack trace.
 */
export async function resolveOwningOrgId(projectId) {
  const cached = getProject(projectId)?.org_id;
  if (typeof cached === "string" && cached.length > 0) return cached;
  try {
    const listed = await getSdk().projects.list();
    const rows = Array.isArray(listed?.projects) ? listed.projects : [];
    const row = rows.find((p) => (p?.id ?? p?.project_id) === projectId);
    const orgId = row?.org_id;
    if (typeof orgId !== "string" || orgId.length === 0) return null;
    try {
      updateProject(projectId, { org_id: orgId });
    } catch {
      // Caching is an optimization; a read-only or contended keystore costs a
      // round trip next time and must never fail the caller.
    }
    return orgId;
  } catch {
    return null;
  }
}
