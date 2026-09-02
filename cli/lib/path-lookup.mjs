/**
 * `path-lookup.mjs` — the tiny, dependency-free "is this executable on
 * PATH" check kygit-handoff design D8 needs twice (`run402 doctor` and
 * `repos view`, both naming `npm i -g @kychee/kygit` when a `kygit::`
 * remote has no `git-remote-kygit` helper installed). No shell, no `which`
 * subprocess — a plain directory scan mirrors what the OS loader itself
 * does to resolve an unqualified command name.
 */
import { accessSync, constants } from "node:fs";
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
