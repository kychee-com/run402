#!/usr/bin/env node
/**
 * `git-remote-kygit` — the git remote-helper for the `kygit::` scheme
 * (design D8, kygit-handoff; kychee-com/run402-private).
 *
 * git derives a remote helper's name from the URL scheme verbatim: a
 * `kygit::acme/notes` remote makes git look for `git-remote-kygit` on PATH,
 * never `git-remote-run402`. `@kychee/kygit` can never ship a bin literally
 * named `git-remote-run402` — npm links bins only for the DIRECTLY
 * installed package, and refuses a global install outright when two
 * packages both claim one bin name — so `npm i -g @kychee/kygit` alone would
 * leave every `kygit::` push failing inside git with an opaque "Unable to
 * find remote helper for 'kygit'". A DIFFERENTLY NAMED bin is the only
 * install that works, which is exactly what this file is.
 *
 * It contains ZERO remote-helper protocol logic of its own: it resolves the
 * installed `run402` package's OWN `git-remote-run402.mjs` (the one real
 * implementation — daemon fast path, in-process fallback, everything) and
 * EXECS it with argv unchanged (git strips the scheme before invoking a
 * helper, so what this process receives on argv is already exactly what
 * `git-remote-run402` expects), stdio inherited, the environment passed
 * through plus `RUN402_REMOTE_SCHEME=kygit`, and the child's exit code
 * propagated. Exec-never-reimplement, same law `kygit.mjs` follows for the
 * porcelain commands.
 */
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { RESOLVE_FAIL_MESSAGE } from "./kygit.mjs";

const requireFromHere = createRequire(import.meta.url);

/** Resolves the installed run402 package's own remote-helper entry file. */
export function resolveHelperPath(req = requireFromHere) {
  return req.resolve("run402/git-remote-run402.mjs");
}

async function main() {
  let helperPath;
  try {
    helperPath = resolveHelperPath();
  } catch {
    process.stderr.write(RESOLVE_FAIL_MESSAGE + "\n");
    process.exitCode = 1;
    return;
  }
  const child = spawn(process.execPath, [helperPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, RUN402_REMOTE_SCHEME: "kygit" },
  });
  await new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
      resolve();
    });
    child.on("error", () => {
      process.stderr.write(RESOLVE_FAIL_MESSAGE + "\n");
      process.exitCode = 1;
      resolve();
    });
  });
}

// Symlink-safe invoked-directly guard — npm installs bins as symlinks, and
// `import.meta.url` is the REAL path, so the comparison must realpath
// argv[1] or every installed invocation is a silent no-op (the same 0.1.0
// bug `kygit.mjs` carries this identical guard to avoid).
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  await main();
}
