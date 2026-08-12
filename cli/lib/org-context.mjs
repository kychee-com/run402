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
import { resolveProjectId } from "./config.mjs";

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
