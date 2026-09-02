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
 *      rewritten argv and `RUN402_REMOTE_SCHEME=kygit` added to the
 *      environment (nothing else in the environment is touched) — stdio
 *      inherited, exit code propagated (design D2). A behavior difference
 *      between `kygit create` and `run402 repos create` is definitionally
 *      a bug in this file.
 *   3. Anything outside the repo family (plus the one `login` funnel
 *      alias) is REFUSED with the exact `run402 …` spelling to use —
 *      the refusal is what keeps this from becoming a second CLI
 *      (design D3).
 *
 * kygit ALSO ships `git-remote-kygit` (see that file) — a second bin, not
 * product logic here, that is what makes a `kygit::` remote actually push
 * and fetch with the shim alone installed. `RUN402_REMOTE_SCHEME=kygit`
 * (set below, at exec) is what makes the canonical CLI RENDER that scheme
 * in everything it prints for this process — `create`'s origin scaffold,
 * `view`, rendered `next_actions` commands — while `run402 repos …` keeps
 * rendering `run402::`. Both spellings resolve the same vault; neither
 * tool ever rewrites a remote the other one wrote (design D8,
 * kygit-handoff — supersedes this file's earlier "no scheme, ever" stance
 * from kygit-standalone-brand D12).
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
 * Warning shown when git could not spawn the `kygit::` remote helper.
 *
 * Every remote this shim scaffolds or renders is spelled `kygit::` (design
 * D8 — `RUN402_REMOTE_SCHEME=kygit` is set above, at exec), so the helper
 * git needs on PATH is `git-remote-kygit`, a bin `@kychee/kygit` ships
 * itself — unlike the pre-D8 world, this is no longer a transitive-dependency
 * bin-linking gap (kychee-com/run402#577): `npm i -g @kychee/kygit` alone
 * links BOTH `kygit` and `git-remote-kygit`, because npm links every bin of
 * the package you install DIRECTLY. This warning is now a defensive check
 * for a broken or partial install (PATH edited after install, a bin
 * hand-removed, …) rather than the expected steady state — reaching it at
 * all means something about THIS install is unusual.
 */
export const HELPER_MISSING_MESSAGE =
  "kygit: warning — git-remote-kygit is not on PATH.\n" +
  "  Plain `git push`/`git fetch` against a kygit:: remote will fail with\n" +
  "  \"fatal: Unable to find remote helper for 'kygit'\".\n" +
  "  Fix: npm i -g @kychee/kygit   (git-remote-kygit is one of that package's bins)";

/**
 * Finds the remote helper the way GIT will: a `git-remote-kygit` executable
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
  // On Windows the npm shim is git-remote-kygit.cmd; git resolves it through
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
      const candidate = joinFor(dir.replace(/^"|"$/g, ""), "git-remote-kygit" + ext);
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

  // The one env addition (design D8): every remote address the canonical CLI
  // renders for THIS process — `create`'s origin scaffold, `view`, rendered
  // next_actions commands — comes out spelled `kygit::` instead of
  // `run402::`. Nothing else in the environment is touched.
  const child = spawn(process.execPath, [client.cliPath, ...plan.args], {
    stdio: "inherit",
    env: { ...process.env, RUN402_REMOTE_SCHEME: "kygit" },
  });
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
