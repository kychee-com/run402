#!/usr/bin/env node
/**
 * kygit — the KyGit brand door to `run402 repos`.
 *
 * Every kygit command IS a run402 command (openspec: kygit-cli-shim,
 * kychee-com/run402-private). This file contains ZERO product logic:
 *
 *   1. The verb table is derived AT RUNTIME from the installed `run402`
 *      package's own `gitvault-surface.json` — the same machine-readable
 *      contract file that truth-gates the marketing pages. Parity with the
 *      canonical CLI is true by construction; there is no generated table
 *      to drift (design D1).
 *   2. Every accepted spelling EXECS the installed run402 CLI with
 *      rewritten argv — stdio inherited, env untouched, exit code
 *      propagated (design D2). A behavior difference between
 *      `kygit create` and `run402 repos create` is definitionally a bug
 *      in this file.
 *   3. Anything outside the repo family (plus the one `login` funnel
 *      alias) is REFUSED with the exact `run402 …` spelling to use —
 *      the refusal is what keeps this from becoming a second CLI
 *      (design D3).
 *
 * No git-remote-kygit, no `kygit::` scheme, ever (design D4).
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, posix as posixPath, win32 as win32Path } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const requireFromHere = createRequire(import.meta.url);

export const RESOLVE_FAIL_MESSAGE =
  "kygit: cannot resolve its run402 engine — the install is incomplete.\n" +
  "  Fix: npm i -g run402 @kychee/kygit   (engine + shim, in one command)\n" +
  "  The engine alone repairs it: npm i -g run402";

/**
 * Warning shown when git could not spawn the `run402::` remote helper.
 *
 * kygit deliberately ships ONE binary (`kygit`) — the remote helper
 * `git-remote-run402` is a bin of the `run402` package, and npm links bins
 * only for the package you install DIRECTLY, never for its dependencies. So
 * `npm i -g @kychee/kygit` alone leaves the helper on disk but off PATH, and
 * the failure lands later, inside git, as an opaque "Unable to find remote
 * helper for 'run402'" (kychee-com/run402#577, found on Windows in
 * kychee-com/run402-private#696 — but it is npm bin-linking, not a Windows
 * quirk, and reproduces on a clean mac).
 *
 * kygit CANNOT fix this by declaring the helper in its own bin: npm fails a
 * global install with EEXIST when a second package claims an already-linked
 * bin name, so that would break `npm i -g @kychee/kygit` for everyone who
 * already has run402 — the common case. (It would also break the shim's
 * "kygit is the only binary" contract.) Naming the one command that works is
 * the whole fix available here.
 */
export const HELPER_MISSING_MESSAGE =
  "kygit: warning — git-remote-run402 is not on PATH.\n" +
  "  Plain `git push`/`git fetch` against a run402:: remote will fail with\n" +
  "  \"fatal: Unable to find remote helper for 'run402'\".\n" +
  "  Fix: npm i -g run402   (the helper is one of that package's bins)";

/**
 * Finds the remote helper the way GIT will: a `git-remote-run402` executable
 * on PATH. Pure — every ambient input is injected so this is testable off the
 * platform it describes.
 */
export function findRemoteHelper({
  env = process.env,
  exists = existsSync,
  platform = process.platform,
} = {}) {
  const windows = platform === "win32";
  const raw = env.PATH ?? env.Path ?? "";
  const dirs = raw.split(windows ? ";" : ":").filter(Boolean);
  // On Windows the npm shim is git-remote-run402.cmd; git resolves it through
  // PATHEXT, so probing the bare name alone would report a false negative.
  const exts = windows
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  // Join with the TARGET platform's rules, not the host's — on a real Windows
  // box these are the same thing, and off it this is what makes the Windows
  // shape testable at all.
  const joinFor = windows ? win32Path.join : posixPath.join;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = joinFor(dir.replace(/^"|"$/g, ""), "git-remote-run402" + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolves the installed run402 package: its dir, package.json, surface, and CLI entry. */
export function resolveClient(req = requireFromHere) {
  const pkgPath = req.resolve("run402/package.json");
  const dir = dirname(pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const surface = JSON.parse(readFileSync(join(dir, "gitvault-surface.json"), "utf8"));
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.run402;
  return { dir, pkg, surface, cliPath: join(dir, binRel) };
}

/** Live `repos <tail>` tails from the surface, as arrays of words. */
export function liveTails(surface) {
  return surface.verbs
    .filter((v) => v.startsWith("repos "))
    .map((v) => v.slice("repos ".length).split(" "));
}

const HELP_WORDS = new Set(["help", "--help", "-h"]);
const VERSION_WORDS = new Set(["--version", "-v", "version"]);

/**
 * Pure dispatch planner. argv = process.argv.slice(2).
 * Returns one of:
 *   {kind:"help"} | {kind:"version"} |
 *   {kind:"exec", args: string[]}         — argv for the run402 CLI
 *   {kind:"refuse", message: string}      — typed refusal, exit 1
 */
export function planInvocation(surface, argv) {
  if (argv.length === 0 || HELP_WORDS.has(argv[0])) return { kind: "help" };
  if (VERSION_WORDS.has(argv[0])) return { kind: "version" };

  // `kygit repos <tail>` is the same thing (people copy run402 docs).
  let words = argv[0] === "repos" ? argv.slice(1) : argv;
  if (words.length === 0) return { kind: "help" };

  // The one funnel alias: the write-capable human session.
  if (words[0] === "login") {
    return { kind: "exec", args: ["operator", "login", "--loopback", ...words.slice(1)] };
  }

  // Leading non-flag words are verb-tail candidates.
  const tails = liveTails(surface);
  const maxTail = Math.max(1, ...tails.map((t) => t.length));
  let lead = 0;
  while (lead < words.length && lead < maxTail && !words[lead].startsWith("-")) lead++;

  const tailSet = new Set(tails.map((t) => t.join(" ")));
  for (let take = lead; take >= 1; take--) {
    if (tailSet.has(words.slice(0, take).join(" "))) {
      return { kind: "exec", args: ["repos", ...words] };
    }
  }

  // Retired spellings answer with their surface-declared successor.
  const retired = new Map((surface.retired_spellings ?? []).map((r) => [r.spelling, r.successor]));
  for (let take = Math.min(words.length, 3); take >= 1; take--) {
    const cand = words.slice(0, take).join(" ");
    for (const spelled of [cand, `repos ${cand}`, `gitvault ${cand}`]) {
      if (retired.has(spelled)) {
        return {
          kind: "refuse",
          message:
            `kygit: '${cand}' is a retired spelling — ${retired.get(spelled)}\n` +
            `  (kygit mounts the live repo verbs at the root: kygit <verb> = run402 repos <verb>)`,
        };
      }
    }
  }

  return {
    kind: "refuse",
    message:
      `kygit: '${words[0]}' is not a kygit command — kygit carries only the repo family (and 'login').\n` +
      `  For everything else use the canonical CLI: run402 ${argv.join(" ")}\n` +
      `  See: npx run402 --help · https://run402.com/llms-full.txt`,
  };
}

export function renderVersion(ownVersion, clientVersion) {
  return `kygit ${ownVersion} (run402 ${clientVersion})`;
}

export function renderHelp(surface, ownVersion, clientVersion) {
  const tails = liveTails(surface).map((t) => t.join(" "));
  const core = ["create", "view", "list"].filter((t) => tails.includes(t));
  const rest = tails.filter((t) => !core.includes(t));
  return [
    `kygit ${ownVersion} — the encrypted Git remote's command (https://kygit.com)`,
    `Every kygit command IS a run402 command (run402 ${clientVersion}); this binary`,
    `only rewrites the spelling. kygit <verb> = run402 repos <verb>.`,
    ``,
    `Start`,
    `  kygit create              provision the vault + scaffold the remote`,
    `  git push origin main      plain git does the pushing`,
    `  kygit view                what this machine and the host each believe`,
    ``,
    `All repo verbs`,
    `  ${[...core, ...rest].join(" · ")}`,
    ``,
    `Humans`,
    `  kygit login               browser sign-in (= run402 operator login --loopback)`,
    ``,
    `Everything else lives on the canonical CLI: npx run402 --help`,
    `Reference: https://run402.com/llms-full.txt`,
  ].join("\n");
}

async function main() {
  let client;
  try {
    client = resolveClient();
  } catch {
    process.stderr.write(RESOLVE_FAIL_MESSAGE + "\n");
    process.exit(1);
  }
  const ownVersion = requireFromHere("./package.json").version;
  const plan = planInvocation(client.surface, process.argv.slice(2));

  if (plan.kind === "help") {
    process.stdout.write(renderHelp(client.surface, ownVersion, client.pkg.version) + "\n");
    return;
  }
  if (plan.kind === "version") {
    process.stdout.write(renderVersion(ownVersion, client.pkg.version) + "\n");
    return;
  }
  if (plan.kind === "refuse") {
    process.stderr.write(plan.message + "\n");
    process.exit(1);
  }
  if (!findRemoteHelper()) process.stderr.write(HELPER_MISSING_MESSAGE + "\n");

  const child = spawn(process.execPath, [client.cliPath, ...plan.args], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  child.on("error", () => {
    process.stderr.write(RESOLVE_FAIL_MESSAGE + "\n");
    process.exit(1);
  });
}

// Guard so tests can import without executing — but npm installs the bin as
// a SYMLINK (node_modules/.bin/kygit -> kygit.mjs), while import.meta.url is
// the REAL path, so the comparison must realpath argv[1] or every installed
// invocation is a silent no-op (the 0.1.0 bug, caught by the cold-install
// smoke on 2026-08-30).
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
