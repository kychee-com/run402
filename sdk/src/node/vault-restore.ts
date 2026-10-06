/**
 * vault — handoff restore (kygit-handoff design D1/D10).
 *
 * Restore is porcelain git, in two stages that deliberately run through
 * DIFFERENT runners:
 *
 *   1. `git clone <remote-url> <dir>` and, when needed, one
 *      `git fetch origin '+refs/run402/*:refs/run402/*'` — REAL network
 *      operations (the vault is reached through the `git-remote-run402`
 *      remote helper), so they must NOT run under `hardenedGit`'s
 *      `-c protocol.allow=never` (that flag exists to keep LOCAL plumbing
 *      calls — hash-object, commit-tree, write-tree — from ever touching
 *      the network by accident; these are the only calls in this module
 *      that are SUPPOSED to). `--no-checkout` so nothing in the target
 *      directory's initial default-branch checkout can fire a
 *      template-installed hook before step 2 neutralizes hooks.
 *   2. Every LOCAL-only step after that (checkout the base, apply the
 *      stash-shaped commit) runs through {@link hardenedGit} exactly like
 *      every other vault plumbing call — hooks, fsmonitor, and replace
 *      refs all disabled, argv-only, no shell.
 *
 * The handoff commit is a `retention root` (design D6), and
 * `restoreObjectsInto` — what the remote helper's `fetch` verb runs —
 * materializes the vault's FULL retained object set, not just
 * ref-reachable history. But `git clone` fetches only `refs/heads/*` and
 * tags: on a vault whose history lives only on `refs/run402/deploys/latest`
 * (populated by `run402 up`, no branch ever pushed) clone never calls the
 * helper's `fetch` verb and the clone is empty. {@link ensureCheckpointObjects}
 * closes that gap with one fetch of the protocol refs.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { LocalError } from "../errors.js";
import { hardenedGit, hardenedGitEnv, run402PassthroughEnv } from "./vault-snapshot.js";

function fail(code: string, message: string, context: string, details?: unknown): never {
  throw new LocalError(message, context, { code, details });
}

let emptyCloneHooksDir: string | null = null;
function cloneHooksDir(): string {
  emptyCloneHooksDir ??= mkdtempSync(join(tmpdir(), "run402-vault-resume-clone-nohooks-"));
  return emptyCloneHooksDir;
}

/**
 * Run one protocol-permitting git command (hooks and terminal prompts still
 * neutralized) and reject with `code` on failure.
 */
function networkGit(argv: string[], cwd: string, failure: { code: string; context: string; details: Record<string, unknown> }): Promise<void> {
  const { code, context, details } = failure;
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["--no-replace-objects", "-c", `core.hooksPath=${cloneHooksDir()}`, ...argv],
      // The remote helper this command spawns authenticates as THIS session: pass
      // the RUN402_* selection through (config dir, wallet, api base, trace).
      // In-process helper, never the resident daemon: the keystore it
      // must read was written moments ago by the same resume, and a daemon
      // that predates that write serves the vault from what it loaded then
      // (live: a post-rotation resume opened only the newest epoch and died
      // VAULT_EPOCH_NOT_OPENABLE at generation 1). A restore gains nothing
      // from a daemon; every later fetch/push in the restored checkout does.
      { cwd, env: { ...hardenedGitEnv(run402PassthroughEnv()), RUN402_DAEMON: "0" }, encoding: "buffer", maxBuffer: 1024 * 1024 * 1024, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) {
          const stderrText = Buffer.from(stderr as Buffer).toString("utf8");
          reject(new LocalError(`git ${argv.filter((a) => a !== "--").join(" ")} failed: ${stderrText.trim().slice(0, 1000) || (error as Error).message}`, context, { code, details: { ...details, stderr: stderrText.slice(0, 2000) } }));
          return;
        }
        resolvePromise();
      },
    );
  });
}

/**
 * `git clone --no-checkout <remoteUrl> <targetDir>`. `targetDir` must not
 * already exist (git's own clone precondition).
 */
export function cloneVaultRemote(remoteUrl: string, targetDir: string): Promise<void> {
  return networkGit(["clone", "--no-checkout", "--", remoteUrl, targetDir], tmpdir(), { code: "HANDOFF_CLONE_FAILED", context: "cloning the vault for resume", details: { remote_url: remoteUrl, target_dir: targetDir } });
}

/**
 * Make sure the checkpoint commit `oid` is in `dir`'s object database. A
 * vault with no branch heads clones empty (see the module comment), so when
 * the commit is absent this fetches the protocol refs from `origin` — the
 * helper's `fetch` verb restores the full retained set, checkpoint and its
 * parents included. No-op when the commit is already present.
 */
export async function ensureCheckpointObjects(dir: string, oid: string): Promise<void> {
  const present = async () => (await hardenedGit(dir, ["cat-file", "-e", `${oid}^{commit}`], { okStatuses: [1, 128] })).status === 0;
  if (await present()) return;
  await networkGit(["fetch", "--no-tags", "origin", "+refs/run402/*:refs/run402/*"], dir, { code: "HANDOFF_CHECKPOINT_FETCH_FAILED", context: "fetching the handoff checkpoint", details: { dir, stash_oid: oid } });
  if (!(await present())) {
    throw new LocalError(`the checkpoint commit ${oid} is not in the vault's retained objects`, "fetching the handoff checkpoint", { code: "HANDOFF_CHECKPOINT_MISSING", details: { stash_oid: oid } });
  }
}

export interface VaultHandoffRestoreOptions {
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

export interface VaultHandoffRestoreResult {
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
export async function applyHandoffCheckpoint(options: VaultHandoffRestoreOptions): Promise<VaultHandoffRestoreResult> {
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
    // The clone's HEAD symref names the vault's default branch only when it
    // exists. An empty clone points HEAD at the unborn `init.defaultBranch`
    // (often `master`), which says nothing about the vault.
    try {
      const symref = sanitizeBranchName((await hardenedGit(dir, ["symbolic-ref", "-q", "--short", "HEAD"], { okStatuses: [1] })).text().trim());
      const born = symref ? (await hardenedGit(dir, ["rev-parse", "-q", "--verify", `refs/heads/${symref}`], { okStatuses: [1] })).status === 0 : false;
      branch = born ? symref : null;
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
 * `name`) when the redeem response carried one, otherwise the vault id.
 * Always absolute — `cloneVaultRemote` runs in `tmpdir()`, so a
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

/**
 * `dir`'s real git directory (`git rev-parse --git-dir`, resolved to an
 * absolute path against `dir` when the answer comes back relative) — the
 * correct place to write LOCAL, never-committed exclusions even from a
 * linked worktree, where `.git` is a file rather than a directory.
 */
async function resolveGitDir(dir: string): Promise<string> {
  const raw = (await hardenedGit(dir, ["rev-parse", "--git-dir"])).text().trim();
  return isAbsolute(raw) ? raw : resolve(dir, raw);
}

/**
 * Add `.run402/` to `dir`'s LOCAL `.git/info/exclude` — never `.gitignore`
 * (kygit-invite design D5): the ignore file is part of the captured tree
 * and touching it would break exact-state on the first `git status` after
 * `join`/`resume`. `.git/info/exclude` is local-only, per-clone git state,
 * exactly like the id-pins in `vault-address.ts`. Idempotent — a second
 * call on an already-excluding checkout is a no-op. Used by BOTH `join` and
 * `resume` (restore is kind-agnostic, kygit-invite design D5).
 */
export async function excludeMessagingCacheFromGit(dir: string): Promise<void> {
  const gitDir = await resolveGitDir(dir);
  const excludePath = join(gitDir, "info", "exclude");
  let existing = "";
  try {
    existing = readFileSync(excludePath, "utf-8");
  } catch {
    existing = "";
  }
  const lines = existing.split("\n");
  if (lines.some((l) => l.trim() === ".run402/")) return; // already excluded
  mkdirSync(dirname(excludePath), { recursive: true });
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  appendFileSync(excludePath, `${needsLeadingNewline ? "\n" : ""}.run402/\n`);
}

/**
 * Read-only counterpart to {@link excludeMessagingCacheFromGit} — whether
 * `dir`'s LOCAL `.git/info/exclude` already carries `.run402/` (kygit-invite
 * design D9's risk list: "`.git/info/exclude` is per-clone and silent" →
 * `repos view` reports `messaging_cache_excluded` so the state is visible).
 * `false` on any read failure (not a repository, no exclude file yet) —
 * never throws.
 */
export async function isMessagingCacheExcludedFromGit(dir: string): Promise<boolean> {
  try {
    const gitDir = await resolveGitDir(dir);
    const excludePath = join(gitDir, "info", "exclude");
    if (!existsSync(excludePath)) return false;
    const existing = readFileSync(excludePath, "utf-8");
    return existing.split("\n").some((l) => l.trim() === ".run402/");
  } catch {
    return false;
  }
}
