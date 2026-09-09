/**
 * Shared git-remote-scaffold fold-in (repo-first-onramp D4, task 2.4).
 *
 * `run402 init`'s 5b block pioneered this pattern; this module is the same
 * additive-only, non-fatal-in-every-branch scaffold factored out so
 * `run402 up` and `run402 repos create` report through the IDENTICAL
 * `gitvault` / `gitvault_skipped` / `gitvault_error` summary keys `init`
 * already uses (plus `status` / `reason` / `toplevel`), instead of
 * near-copies drifting apart. `projects provision` never scaffolds: it is
 * the provisioning primitive and has no local side effects. `init.mjs` itself is left untouched — its own scaffold block is
 * shipped and tested; this module exists for the NEW callers task 2.4 adds.
 *
 * Never creates a repository on its own unless `createRepoIfMissing` is
 * explicit (mirrors `init`'s `--git-remote` opt-in): a directory the caller
 * did not ask to turn into a repository is left alone. The remote is always
 * `run402` and `origin` is never touched or claimed; a directory that lies
 * inside ANOTHER repository is reported `skipped` with the enclosing
 * toplevel named — that repository is never touched (first-deploy-agent-dx). Every
 * branch is non-fatal — a missing git, an unresolvable org, or an
 * unreachable gateway all report and return, never throw.
 */
import { getSdk } from "./sdk.mjs";
import { resolveOwningOrgId } from "./org-context.mjs";

/**
 * @param {object} options
 * @param {string} [options.repoDir] Working tree to scaffold. Defaults to `process.cwd()`.
 * @param {string} options.projectId The project the remote should point at.
 * @param {string} [options.orgId] Explicit owning org. Resolved via `resolveOwningOrgId` when omitted.
 * @param {boolean} [options.createRepoIfMissing] Opt into `git init`-ing `repoDir` when it is not a repository yet.
 * @returns {Promise<{status: "scaffolded"|"skipped"|"error", reason?: string, toplevel?: string|null, gitvault: object|null, gitvault_skipped?: string, gitvault_error?: {code: string, message: string}}>}
 */
export async function scaffoldGitvaultRemote({ repoDir = process.cwd(), projectId, orgId, createRepoIfMissing = false } = {}) {
  const out = { gitvault: null, status: "skipped" };
  try {
    const { hardenedGit } = await import("#sdk/node");
    let insideRepo = true;
    try {
      await hardenedGit(repoDir, ["rev-parse", "--git-dir"]);
    } catch {
      insideRepo = false;
    }
    if (!insideRepo && !createRepoIfMissing) {
      out.reason = "not_a_repository";
      out.gitvault_skipped = "not a git repository — re-run with --git-remote to create one and add the remote";
      return out;
    }
    const resolvedOrgId = orgId ?? (await resolveOwningOrgId(projectId));
    if (!resolvedOrgId) {
      out.reason = "org_unresolved";
      out.gitvault_skipped = `could not resolve the owning org for ${projectId} — the run402 remote was not added`;
      return out;
    }
    const remote = await getSdk().gitvault.scaffoldRemote({ repo_dir: repoDir, org_id: resolvedOrgId, project_id: projectId });
    if (remote.status === "skipped") {
      // The app root lies INSIDE some other repository (first-deploy-agent-dx
      // D3): that repository is never touched. Say which one, and why.
      out.reason = "inside_other_repository";
      out.toplevel = remote.toplevel ?? null;
      out.gitvault_skipped = remote.reason;
      return out;
    }
    // `allocated: false` is stated, not left to be inferred: this is local
    // git only — no vault exists for the project yet (allocation happens
    // lazily on first push, or explicitly via `run402 repos create --project <id>`).
    out.status = "scaffolded";
    out.gitvault = { ...remote, allocated: false };
  } catch (err) {
    out.gitvault = null;
    out.status = "error";
    out.gitvault_error = { code: err?.body?.code ?? err?.code ?? "GITVAULT_SCAFFOLD_FAILED", message: err?.message ?? String(err) };
  }
  return out;
}
