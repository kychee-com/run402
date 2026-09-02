/**
 * gitvault — handoff restore (kygit-handoff design D1/D10).
 *
 * Restore is porcelain git, in two stages that deliberately run through
 * DIFFERENT runners:
 *
 *   1. `git clone <remote-url> <dir>` — a REAL network operation (the vault
 *      is reached through the `git-remote-run402`/`git-remote-kygit` remote
 *      helper), so it must NOT run under `hardenedGit`'s
 *      `-c protocol.allow=never` (that flag exists to keep LOCAL plumbing
 *      calls — hash-object, commit-tree, write-tree — from ever touching
 *      the network by accident; a clone is the one call in this whole
 *      module that is SUPPOSED to). `--no-checkout` so nothing in the
 *      target directory's initial default-branch checkout can fire a
 *      template-installed hook before step 2 neutralizes hooks.
 *   2. Every LOCAL-only step after that (checkout the base, apply the
 *      stash-shaped commit) runs through {@link hardenedGit} exactly like
 *      every other gitvault plumbing call — hooks, fsmonitor, and replace
 *      refs all disabled, argv-only, no shell.
 *
 * The handoff commit ITSELF needs no separate fetch: it is a `retention
 * root` (design D6), and `restoreObjectsInto` — what the remote helper's
 * `fetch` verb runs on every clone — materializes the vault's FULL
 * retained object set, not just ref-reachable history. By the time step 1
 * finishes, `<oid>` is already a loose object in the fresh clone's ODB.
 */
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { LocalError } from "../errors.js";
import { hardenedGit, hardenedGitEnv } from "./gitvault-snapshot.js";

function fail(code: string, message: string, context: string, details?: unknown): never {
  throw new LocalError(message, context, { code, details });
}

let emptyCloneHooksDir: string | null = null;
function cloneHooksDir(): string {
  emptyCloneHooksDir ??= mkdtempSync(join(tmpdir(), "run402-gitvault-resume-clone-nohooks-"));
  return emptyCloneHooksDir;
}

/**
 * `git clone --no-checkout <remoteUrl> <targetDir>` — protocol-permitting
 * (this is the one gitvault git invocation allowed to touch the network),
 * hooks and terminal prompts still neutralized. `targetDir` must not
 * already exist (git's own clone precondition).
 */
export function cloneGitvaultRemote(remoteUrl: string, targetDir: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const argv = ["--no-replace-objects", "-c", `core.hooksPath=${cloneHooksDir()}`, "clone", "--no-checkout", "--", remoteUrl, targetDir];
    execFile(
      "git",
      argv,
      { cwd: tmpdir(), env: hardenedGitEnv(), encoding: "buffer", maxBuffer: 1024 * 1024 * 1024, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) {
          const stderrText = Buffer.from(stderr as Buffer).toString("utf8");
          reject(new LocalError(`git clone ${remoteUrl} failed: ${stderrText.trim().slice(0, 1000) || (error as Error).message}`, "cloning the vault for resume", { code: "HANDOFF_CLONE_FAILED", details: { remote_url: remoteUrl, target_dir: targetDir, stderr: stderrText.slice(0, 2000) } }));
          return;
        }
        resolvePromise();
      },
    );
  });
}

export interface GitvaultHandoffRestoreOptions {
  /** The freshly cloned repository. */
  dir: string;
  /** The stash-shaped commit oid (design D1) — must already be reachable in `dir`'s object database (a retention root, materialized by clone). */
  stash_oid: string;
  /**
   * `<stash_oid>`'s first parent (design D1's `base_head_oid`). When
   * omitted it is read directly off the commit (`git rev-parse
   * <stash_oid>^1`) — the object already carries it, so a caller resuming
   * from the sealed envelope's `checkpoint.commit_oid` alone needs no
   * second value to agree with it.
   */
  base_head_oid?: string;
  /** The vault's default branch name (e.g. from the head symref, stripped of `refs/heads/`). Read from the fresh clone's `HEAD` symref when omitted; falls back to `main`. */
  branch_hint?: string | null;
}

export interface GitvaultHandoffRestoreResult {
  branch: string;
  base_head_oid: string;
  stash_oid: string;
}

function sanitizeBranchName(name: string | null | undefined): string | null {
  return name && /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith("-") ? name : null;
}

/**
 * Check out the base, land on a real branch (never left detached), then
 * `git stash apply --index <stash_oid>` — staged, unstaged, deleted, and
 * untracked changes come back distinctly (verified against real git 2.43
 * plumbing during design). Every step here is LOCAL — no network — so it
 * runs fully hardened.
 */
export async function applyHandoffCheckpoint(options: GitvaultHandoffRestoreOptions): Promise<GitvaultHandoffRestoreResult> {
  const { dir } = options;
  let baseHeadOid = options.base_head_oid ?? null;
  if (!baseHeadOid) {
    try {
      baseHeadOid = (await hardenedGit(dir, ["rev-parse", "--verify", `${options.stash_oid}^1`])).text().trim();
    } catch (e) {
      fail("HANDOFF_RESTORE_APPLY_FAILED", `could not read the base commit (first parent) off ${options.stash_oid} — it may not be present in the clone yet`, "restoring the handoff checkpoint", { stash_oid: options.stash_oid, cause: e instanceof Error ? e.message : String(e) });
    }
  }
  let branch = sanitizeBranchName(options.branch_hint);
  if (!branch) {
    try {
      const symref = (await hardenedGit(dir, ["symbolic-ref", "-q", "--short", "HEAD"], { okStatuses: [1] })).text().trim();
      branch = sanitizeBranchName(symref);
    } catch {
      branch = null;
    }
  }
  branch ??= "main";
  await hardenedGit(dir, ["checkout", "-q", baseHeadOid]);
  await hardenedGit(dir, ["checkout", "-q", "-B", branch]);
  try {
    await hardenedGit(dir, ["stash", "apply", "--index", options.stash_oid]);
  } catch (e) {
    fail("HANDOFF_RESTORE_APPLY_FAILED", `\`git stash apply --index\` failed to reconstruct the handed-off state: ${e instanceof Error ? e.message : String(e)}`, "restoring the handoff checkpoint", { base_head_oid: baseHeadOid, stash_oid: options.stash_oid, cause: e instanceof Error ? e.message : String(e) });
  }
  return { branch, base_head_oid: baseHeadOid, stash_oid: options.stash_oid };
}

/**
 * `--to <dir>` wins; otherwise the vault's address-form name (`org/name` →
 * `name`) when the claim response carried one, otherwise the vault id.
 * Always absolute — `cloneGitvaultRemote` runs in `tmpdir()`, so a
 * relative destination must be resolved against the CALLER's cwd first.
 */
export function resolveResumeTargetDir(to: string | undefined, address: string | null | undefined, vaultId: string): string {
  if (to) return isAbsolute(to) ? to : resolve(process.cwd(), to);
  const name = address ? address.split("/").pop() : null;
  return resolve(process.cwd(), name || vaultId);
}

/** The commit message (the Handoff Note, verbatim) — `null` when `oid` cannot be read (e.g. not yet present). */
export async function readGitCommitMessage(dir: string, oid: string): Promise<string | null> {
  try {
    return (await hardenedGit(dir, ["log", "-1", "--format=%B", oid])).text().replace(/\n$/, "");
  } catch {
    return null;
  }
}
