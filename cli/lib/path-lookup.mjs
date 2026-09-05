/**
 * `path-lookup.mjs` — the tiny, dependency-free "is this executable on
 * PATH" check kygit-handoff design D8 needs twice (`run402 doctor` and
 * `repos view`, both naming `npm i -g @kychee/kygit` when a `kygit::`
 * remote has no `git-remote-kygit` helper installed). No shell, no `which`
 * subprocess — a plain directory scan mirrors what the OS loader itself
 * does to resolve an unqualified command name.
 */
import {accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** True iff `name` resolves to an executable file somewhere on `PATH`. Windows `PATHEXT` is out of scope — this CLI targets POSIX (`engines.node` + the hardened-git doc comments assume it) — so no `.exe`/`.cmd` suffix search. */
export function isExecutableOnPath(name, env = process.env) {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // not here — keep looking
    }
  }
  return false;
}

/**
 * After a restore into `dir`, the ONE thing that still stands between the
 * caller and its first `git push` is git finding the remote helper the
 * checkout's origin scheme names (`git-remote-kygit` for `kygit::`,
 * `git-remote-run402` for `run402::`). A resume or join run through
 * `npx` has the helper only inside the npx cache, so git cannot see it.
 * Returns a `next_actions` entry naming the fix, or null when the helper
 * is on PATH or the checkout's remote cannot be read (never throws).
 */
export function remoteHelperNextAction(dir, env = process.env) {
  let url = null;
  try {
    const cfg = readFileSync(join(dir, ".git", "config"), "utf8");
    const m = cfg.match(/\[remote "origin"\][^[]*?\n\s*url\s*=\s*(\S+)/);
    url = m ? m[1] : null;
  } catch {
    return null;
  }
  if (!url) return null;
  const helper = url.startsWith("kygit::") ? "git-remote-kygit" : url.startsWith("run402::") ? "git-remote-run402" : null;
  if (!helper || isExecutableOnPath(helper, env)) return null;
  return {
    type: "install_remote_helper",
    command: "npm i -g @kychee/kygit run402",
    why: `git push needs ${helper} on PATH and this session does not have it there (an npx run keeps it inside the npx cache); install both packages once and every git command in this checkout works`,
  };
}
