/**
 * gitvault — snapshot + hardened git execution (protocol rev 41 §6.6; task 5.5).
 *
 * Snapshot policy: clean tree → `HEAD`; dirty → REFUSED BY DEFAULT
 * (`SNAPSHOT_DIRTY_TREE`, before any object is created) unless
 * `allowDirty: true`, in which case a synthetic commit of tracked +
 * untracked-not-ignored paths is captured (parented on HEAD; parentless on
 * an unborn HEAD) and the result discloses exactly what got swept in
 * (`modified_captured` / `untracked_captured`). "Dirty" means any modified
 * or staged tracked path, or any untracked-not-ignored path — a project
 * whose build step writes gitignored output is never dirty on that account.
 * Unmerged index → `SNAPSHOT_CONFLICTED_INDEX` (checked first — allowDirty
 * does not touch it); detached HEAD is representable; linked worktrees, bare
 * layouts, sparse checkouts, shallow clones, submodules, SHA-256
 * repositories, alternates/grafts, and active filters on any captured path
 * are REFUSED BY NAME before any object is created.
 *
 * Ignore authority is FROZEN and read AS DATA: repository `.gitignore`,
 * `.git/info/exclude`, and the user's global excludes file. The global path
 * is discovered deterministically (round-6 M11) by parsing
 * `$XDG_CONFIG_HOME/git/config` then `~/.gitconfig` with a frozen config
 * subset (last value wins, `~/`/`$HOME` expansion only; `include`/`includeIf`
 * or an unreadable config/excludes file → refuse by name). git never sees the
 * user's config: the discovered file is handed to `git ls-files` as an
 * `--exclude-from` pattern source, so git's matcher runs over OUR discovery.
 *
 * Object creation NEVER invokes filters for any path (tracked or untracked):
 * bytes are hashed with `git hash-object --no-filters`; every included path is
 * first checked with `git check-attr filter`, and any configured filter (LFS
 * included) refuses the capture by name — no clean/smudge/process command is
 * ever started (the acceptance test asserts a sentinel the filter would write
 * never appears).
 *
 * The capture also records the CAPTURED SET (`snapshot.captured`) and a digest
 * over it (`snapshot.captured_digest`). The deploy lane re-derives that digest
 * after artifacts are collected and before a plan commits, and refuses
 * `SNAPSHOT_MOVED_DURING_DEPLOY` on any difference. The set is tracked plus
 * untracked-but-not-ignored — so a build rewriting gitignored output changes
 * nothing, deliberately.
 *
 * Every git invocation is argv-only (no shell), with `GIT_*` cleared,
 * `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null` (no user config), an
 * empty `core.hooksPath`, `--no-replace-objects`, `core.fsmonitor=false`, and
 * no alternates. Repository-config `include`/`includeIf` is refused by name
 * (git applies it before any `-c`; there is no override switch).
 */

import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalError, type NextAction } from "../errors.js";
import { GITVAULT_OID40_RE, deriveDigestKey, keyedCommitment, sha256Hex, snapshotOidContent } from "../namespaces/gitvault.crypto.js";
import type { GitvaultHeadTarget } from "../namespaces/gitvault.types.js";

// ─── Constants (constants.json) ──────────────────────────────────────────────

/** `MAX_GIT_OBJECT_BYTES` — any single object above this is `GIT_OBJECT_TOO_LARGE`. */
export const GITVAULT_MAX_GIT_OBJECT_BYTES = 200 * 1024 * 1024;
/** `refs/run402/deploys/latest` — the single protocol-owned deploy ref (round-3 H9). */
export const GITVAULT_DEPLOY_REF = "refs/run402/deploys/latest";
/** Probed git version range: `[2.32, ∞)` — `GIT_CONFIG_GLOBAL` landed in 2.32. */
export const GITVAULT_MIN_GIT_VERSION = [2, 32] as const;

function fail(code: string, message: string, context: string, details?: unknown, next_actions?: NextAction[]): never {
  throw new LocalError(message, context, { code, details, ...(next_actions ? { next_actions } : {}) });
}

// ─── Hardened runner ─────────────────────────────────────────────────────────

export interface HardenedGitOptions {
  /** Bytes written to stdin (closed immediately when omitted). */
  input?: Uint8Array | string;
  /** Extra environment members — only `GIT_INDEX_FILE` and the author/committer identity are ever passed here. */
  env?: Record<string, string>;
  /** Accept these non-zero exit statuses instead of throwing. */
  okStatuses?: number[];
  /** Max stdout bytes (packs are large). Default 1 GiB. */
  maxBuffer?: number;
}

export interface HardenedGitResult {
  status: number;
  stdout: Buffer;
  stderr: string;
  text(): string;
  lines(): string[];
  /** NUL-separated output → entries (trailing NUL dropped). */
  nul(): string[];
}

let emptyHooksDir: string | null = null;
function hooksPath(): string {
  if (!emptyHooksDir) {
    emptyHooksDir = mkdtempSync(join(tmpdir(), "run402-gitvault-nohooks-"));
  }
  return emptyHooksDir;
}

/** The environment every gitvault git process runs under — nothing inherited except PATH. */
export function hardenedGitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    // hash-object/commit-tree identity for synthetic commits — fixed, never the user's.
    GIT_AUTHOR_NAME: "run402 gitvault",
    GIT_AUTHOR_EMAIL: "gitvault@run402.com",
    GIT_COMMITTER_NAME: "run402 gitvault",
    GIT_COMMITTER_EMAIL: "gitvault@run402.com",
  };
  if (process.env.HOME) env.HOME = process.env.HOME; // only so /dev/null config resolution has a home; never read.
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

/**
 * The `RUN402_*` environment this process was configured with — for the ONE
 * gitvault git invocation that touches the network (`cloneGitvaultRemote`):
 * that clone spawns the `git-remote-kygit` / `git-remote-run402` helper,
 * which must authenticate as THIS session's wallet and config dir. Under the
 * bare {@link hardenedGitEnv} the helper saw no `RUN402_CONFIG_DIR` /
 * `RUN402_WALLET` / `RUN402_API_BASE` and fell back to the machine's default
 * config — a different wallet, not a member of the vault's org — so a
 * `resume` on any machine that selects its identity by env (a laptop with
 * several agent config dirs, a CI job, a harness with `RUN402_WALLET`) died
 * `GITVAULT_ACCESS_DENIED` "while resolving the project's gitvault" right
 * after a successful claim (kygit-handoff live rerun, 2026-09-03). Only
 * `RUN402_*` keys pass; git's own hardening is untouched.
 */
export function run402PassthroughEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (k.startsWith("RUN402_") && typeof v === "string") out[k] = v;
  }
  return out;
}

/** The argv prefix that neutralizes hooks, fsmonitor, replace refs, and filter autodetection for every invocation. */
export const HARDENED_GIT_ARGV_PREFIX = (): string[] => [
  "--no-replace-objects",
  "-c", `core.hooksPath=${hooksPath()}`,
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", "core.commitGraph=false",
  "-c", "gc.auto=0",
  "-c", "protocol.allow=never",
];

/**
 * Run git with explicit args (no shell) in `cwd` under the hardened env.
 * Throws `GIT_COMMAND_FAILED` on a non-ok exit.
 *
 * Node's `execFile` reports a MISSING `cwd` with the exact same `ENOENT` as a
 * missing `git` binary, so a caller that forgot to create its working
 * directory (e.g. `recover`'s `out_dir` before this fix) saw the misleading
 * `GIT_UNAVAILABLE: git could not be executed` even though git itself was
 * perfectly installed. Disambiguate BEFORE spawning: a missing `cwd` is its
 * own distinct, honest refusal, never folded into "git is unavailable."
 */
export function hardenedGit(cwd: string, args: string[], options: HardenedGitOptions = {}): Promise<HardenedGitResult> {
  if (!existsSync(cwd)) {
    return Promise.reject(new LocalError(`git working directory does not exist: ${cwd}`, "running hardened git", { code: "GIT_CWD_MISSING", details: { cwd, args } }));
  }
  const argv = [...HARDENED_GIT_ARGV_PREFIX(), ...args];
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      "git",
      argv,
      { cwd, env: hardenedGitEnv(options.env), encoding: "buffer", maxBuffer: options.maxBuffer ?? 1024 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const status = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((error as { code: number }).code) : error ? -1 : 0;
        const stderrText = Buffer.from(stderr as Buffer).toString("utf8");
        if (error && status === -1) {
          reject(new LocalError(`git could not be executed: ${(error as Error).message}`, "running hardened git", { code: "GIT_UNAVAILABLE", details: { args: argv }, cause: error }));
          return;
        }
        if (status !== 0 && !(options.okStatuses ?? []).includes(status)) {
          reject(new LocalError(`git ${args[0] ?? ""} failed (exit ${status}): ${stderrText.trim().slice(0, 500)}`, "running hardened git", { code: "GIT_COMMAND_FAILED", details: { args, status, stderr: stderrText.slice(0, 2000) } }));
          return;
        }
        const out = Buffer.from(stdout as Buffer);
        resolvePromise({
          status,
          stdout: out,
          stderr: stderrText,
          text: () => out.toString("utf8"),
          lines: () => out.toString("utf8").split("\n").filter((l) => l.length > 0),
          nul: () => out.toString("utf8").split("\0").filter((l) => l.length > 0),
        });
      },
    );
    if (options.input !== undefined) child.stdin?.end(typeof options.input === "string" ? Buffer.from(options.input, "utf8") : Buffer.from(options.input));
    else child.stdin?.end();
  });
}

// ─── Which repository did git invoke us for? (fail-closed) ───────────────────

/**
 * The repository a `git-remote-*` helper was invoked for.
 *
 * `repo_dir` is what every hardened git call takes as `cwd`. Because
 * {@link hardenedGitEnv} builds its environment from scratch — `GIT_DIR` is
 * never inherited — git's discovery starts at that directory, and starting it
 * AT the git directory makes discovery land on that repository and no other.
 */
export interface GitInvocationRepo {
  /** The absolute git directory git named for this invocation. */
  git_dir: string;
  /** Hand this to `hardenedGit` as `cwd`; discovery from here resolves to `git_dir`. */
  repo_dir: string;
}

/** `realpath` when it resolves, the input otherwise — path equality across `/tmp` → `/private/tmp` and friends. */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve — and PROVE — the repository git invoked this helper for.
 *
 * git always sets `GIT_DIR` when it runs a remote helper against a
 * repository: `.git` (relative, cwd already moved to the top level) for
 * fetch/push, the linked worktree's git dir inside a worktree, `.` in a bare
 * repository, and the ABSOLUTE path of the not-yet-populated target during
 * `git clone`. It is unset only for a repository-free invocation such as
 * `git ls-remote <url>` run outside any checkout, which needs no repository
 * at all.
 *
 * So `process.cwd()` is NOT the repository: during a clone it is the directory
 * the user ran clone FROM, which is routinely inside some unrelated repo. A
 * helper that discovers its repository from cwd therefore writes the vault's
 * decrypted objects into a repository the user never named — the leak this
 * function exists to make impossible. It fails closed: no `GIT_DIR`, a
 * `GIT_DIR` that is not a repository, or a `GIT_DIR` whose own
 * `--absolute-git-dir` disagrees with the path we were handed, all refuse.
 * The caller must write nothing after a refusal.
 */
export async function resolveGitInvocationRepo(
  env: { GIT_DIR?: string | undefined } = process.env,
  cwd: string = process.cwd(),
): Promise<GitInvocationRepo> {
  const declared = typeof env.GIT_DIR === "string" ? env.GIT_DIR.trim() : "";
  if (declared === "") {
    fail(
      "GIT_INVOCATION_REPO_UNRESOLVED",
      "git set no GIT_DIR for this invocation, so the repository it wants operated on cannot be established; refusing rather than guessing from the current directory",
      "resolving the invoking git repository",
      { reason: "no_git_dir", cwd },
    );
  }
  const absolute = resolve(cwd, declared);
  let observed: string;
  try {
    observed = (await hardenedGit(absolute, ["rev-parse", "--absolute-git-dir"])).text().trim();
  } catch (cause) {
    fail(
      "GIT_INVOCATION_REPO_UNRESOLVED",
      `GIT_DIR ${absolute} is not a readable git repository`,
      "resolving the invoking git repository",
      { reason: "git_dir_not_a_repository", git_dir: absolute, cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  // The proof: discovery started AT the named directory must come back to that
  // same directory. A `GIT_DIR` pointing at a plain subdirectory of some other
  // repository resolves upward to that other repository — which is exactly the
  // confusion that must never be acted on.
  if (canonicalPath(observed) !== canonicalPath(absolute)) {
    fail(
      "GIT_INVOCATION_REPO_UNRESOLVED",
      `GIT_DIR ${absolute} resolves to a different repository (${observed}); refusing to operate on a repository git did not name`,
      "resolving the invoking git repository",
      { reason: "git_dir_mismatch", git_dir: absolute, resolved: observed },
    );
  }
  return { git_dir: observed, repo_dir: observed };
}

/** `git version` parsed as [major, minor]; refuses below {@link GITVAULT_MIN_GIT_VERSION}. */
export async function probeGitVersion(cwd: string = process.cwd()): Promise<[number, number]> {
  const r = await hardenedGit(cwd, ["version"]);
  const m = /git version (\d+)\.(\d+)/.exec(r.text());
  if (!m) fail("GIT_UNAVAILABLE", `unrecognized git version output: ${r.text().trim()}`, "probing git version");
  const v: [number, number] = [Number(m[1]), Number(m[2])];
  const [minMajor, minMinor] = GITVAULT_MIN_GIT_VERSION;
  if (v[0] < minMajor || (v[0] === minMajor && v[1] < minMinor)) {
    fail("GIT_VERSION_UNSUPPORTED", `git ${v[0]}.${v[1]} is below the supported ${minMajor}.${minMinor}`, "probing git version", { version: v });
  }
  return v;
}

// ─── Global excludes discovery (round-6 M11) — config parsed AS DATA ─────────

export interface GitConfigDiscoveryEnv {
  HOME?: string;
  XDG_CONFIG_HOME?: string;
}

/** The frozen config subset: `[section "sub"]` headers + `key = value` lines; quoting per git-config; comments `#`/`;`. */
export interface ParsedGitConfigEntry {
  section: string;
  subsection: string | null;
  key: string;
  value: string;
  file: string;
}

export type GlobalExcludesRefusal =
  | { code: "GITVAULT_CONFIG_INCLUDE_REFUSED"; file: string; key: string }
  | { code: "GITVAULT_CONFIG_UNREADABLE"; file: string }
  | { code: "GITVAULT_EXCLUDES_PATH_UNSUPPORTED"; file: string; value: string }
  | { code: "GITVAULT_EXCLUDES_UNREADABLE"; file: string };

export interface GlobalExcludesDiscovery {
  /** The resolved excludes path — `null` when no file exists (an absent DEFAULT path is fine; an absent EXPLICIT `core.excludesFile` is also fine — git ignores it too). */
  path: string | null;
  /** Which config (if any) set `core.excludesFile`. */
  source: "core.excludesFile" | "default" ;
  /** The config files that were read (in read order). */
  configs_read: string[];
  /** The pattern bytes, read as data, when `path` exists. */
  patterns: string | null;
}

function unquoteConfigValue(raw: string): string {
  // git-config: value runs to end of line; `#`/`;` outside quotes start a comment; backslash escapes \" \\ \n \t \b; quoted segments keep spaces.
  let out = "";
  let inQuote = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "\\" && i + 1 < raw.length) {
      const n = raw[++i]!;
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === "b" ? "\b" : n;
      continue;
    }
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (!inQuote && (ch === "#" || ch === ";")) break;
    out += ch;
  }
  return inQuote ? out : out.trim();
}

/** Parse a git config file as data (frozen subset). Throws by name on `include`/`includeIf`. */
export function parseGitConfigAsData(text: string, file: string): ParsedGitConfigEntry[] {
  const entries: ParsedGitConfigEntry[] = [];
  let section = "";
  let subsection: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\]$/.exec(line);
    if (header) {
      section = header[1]!.toLowerCase();
      subsection = header[2] !== undefined ? header[2].replace(/\\(.)/g, "$1") : null;
      // `[section.sub]` legacy form — lowercase everything.
      if (subsection === null && section.includes(".")) {
        const dot = section.indexOf(".");
        subsection = section.slice(dot + 1);
        section = section.slice(0, dot);
      }
      if (section === "include" || section === "includeif") {
        throw new LocalError(`${file}: [${section}] is not supported by the frozen ignore-authority discovery; remove it or set core.excludesFile directly`, "discovering global excludes", { code: "GITVAULT_CONFIG_INCLUDE_REFUSED", details: { file, key: section } });
      }
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!kv) continue; // not in the subset — ignored as data
    entries.push({ section, subsection, key: kv[1]!.toLowerCase(), value: kv[2] === undefined ? "true" : unquoteConfigValue(kv[2]), file });
  }
  return entries;
}

function expandConfigPath(value: string, home: string | undefined, file: string): string {
  if (value.startsWith("~/")) {
    if (!home) fail("GITVAULT_EXCLUDES_PATH_UNSUPPORTED", `${file}: core.excludesFile uses ~/ but HOME is unset`, "discovering global excludes", { file, value });
    return join(home, value.slice(2));
  }
  if (value.startsWith("$HOME/") || value === "$HOME") {
    if (!home) fail("GITVAULT_EXCLUDES_PATH_UNSUPPORTED", `${file}: core.excludesFile uses $HOME but HOME is unset`, "discovering global excludes", { file, value });
    return join(home, value.slice(5));
  }
  if (value.startsWith("/")) return value;
  fail("GITVAULT_EXCLUDES_PATH_UNSUPPORTED", `${file}: core.excludesFile "${value}" is relative or environment-dependent; only absolute, ~/, and $HOME/ paths are supported`, "discovering global excludes", { file, value });
}

function readAsData(file: string, code: "GITVAULT_CONFIG_UNREADABLE" | "GITVAULT_EXCLUDES_UNREADABLE", context: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw new LocalError(`${file} exists but is unreadable (${err.code ?? "error"}); refusing the capture rather than silently widening the snapshot`, context, { code, details: { file, errno: err.code }, cause: e });
  }
}

/**
 * Deterministic discovery of the user's global excludes file (M11):
 * `$XDG_CONFIG_HOME/git/config` (default `~/.config/git/config`) THEN
 * `~/.gitconfig`, last value wins; default `$XDG_CONFIG_HOME/git/ignore`
 * falling back to `~/.config/git/ignore`. Every refusal names its file.
 */
export function discoverGlobalExcludes(env: GitConfigDiscoveryEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }): GlobalExcludesDiscovery {
  const home = env.HOME;
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith("/") ? env.XDG_CONFIG_HOME : home ? join(home, ".config") : null;
  const configs: string[] = [];
  if (xdg) configs.push(join(xdg, "git", "config"));
  if (home) configs.push(join(home, ".gitconfig"));
  let excludes: { value: string; file: string } | null = null;
  const read: string[] = [];
  for (const file of configs) {
    const text = readAsData(file, "GITVAULT_CONFIG_UNREADABLE", "discovering global excludes");
    if (text === null) continue;
    read.push(file);
    for (const e of parseGitConfigAsData(text, file)) {
      if (e.section === "core" && e.subsection === null && e.key === "excludesfile") excludes = { value: e.value, file };
    }
  }
  let path: string | null;
  let source: GlobalExcludesDiscovery["source"];
  if (excludes) {
    path = expandConfigPath(excludes.value, home, excludes.file);
    source = "core.excludesFile";
  } else {
    source = "default";
    const candidates = [xdg ? join(xdg, "git", "ignore") : null, home ? join(home, ".config", "git", "ignore") : null].filter((p): p is string => p !== null);
    path = candidates.find((p) => existsSync(p)) ?? null;
  }
  let patterns: string | null = null;
  if (path) {
    patterns = readAsData(path, "GITVAULT_EXCLUDES_UNREADABLE", "reading global excludes as data");
    if (patterns === null) path = source === "default" ? null : path; // an explicitly configured but absent file: git ignores it too
  }
  return { path: patterns === null ? null : path, source, configs_read: read, patterns };
}

// ─── Repository inspection — refusals by name ────────────────────────────────

export type GitvaultRepositoryRefusalCode =
  | "GITVAULT_BARE_REPOSITORY"
  | "GITVAULT_LINKED_WORKTREE"
  | "GITVAULT_SPARSE_CHECKOUT"
  | "GITVAULT_SHALLOW_CLONE"
  | "GITVAULT_SUBMODULES_UNSUPPORTED"
  | "GIT_OBJECT_FORMAT_UNSUPPORTED"
  | "GITVAULT_ALTERNATES_UNSUPPORTED"
  | "GITVAULT_GRAFTS_UNSUPPORTED"
  | "GITVAULT_CONFIG_INCLUDE_REFUSED"
  | "GITVAULT_NOT_A_REPOSITORY";

export interface GitvaultRepositoryInspection {
  top_level: string;
  git_dir: string;
  git_common_dir: string;
  object_format: "sha1";
  head: GitvaultHeadTarget & { resolved_oid: string | null };
  unmerged_paths: string[];
}

async function gitRevParse(dir: string, flag: string): Promise<string> {
  return (await hardenedGit(dir, ["rev-parse", flag])).text().trim();
}

/** Inspect `dir`; every unsupported layout is refused with its named code. */
export async function inspectRepository(dir: string): Promise<GitvaultRepositoryInspection> {
  const abs = resolve(dir);
  // `--is-bare-repository` FIRST: inside a bare repository `--show-toplevel` fails (there is no
  // work tree), so probing it first would report every bare repo as "not a repository".
  let bare: string;
  try {
    bare = await gitRevParse(abs, "--is-bare-repository");
  } catch (e) {
    fail("GITVAULT_NOT_A_REPOSITORY", `${abs} is not inside a git repository`, "inspecting repository", { dir: abs, cause: String((e as Error).message) });
  }
  if (bare === "true") fail("GITVAULT_BARE_REPOSITORY", "bare repositories are refused: a snapshot needs a work tree", "inspecting repository", { dir: abs });
  let top: string;
  try {
    top = await gitRevParse(abs, "--show-toplevel");
  } catch (e) {
    fail("GITVAULT_NOT_A_REPOSITORY", `${abs} is not inside a git work tree`, "inspecting repository", { dir: abs, cause: String((e as Error).message) });
  }
  const gitDir = resolve(top, await gitRevParse(top, "--git-dir"));
  const commonDir = resolve(top, await gitRevParse(top, "--git-common-dir"));
  if (gitDir !== commonDir) fail("GITVAULT_LINKED_WORKTREE", `linked worktrees are refused by name: ${top} is a linked worktree of ${commonDir}`, "inspecting repository", { worktree: top, git_dir: gitDir, git_common_dir: commonDir });
  if ((await gitRevParse(top, "--is-shallow-repository")) === "true") fail("GITVAULT_SHALLOW_CLONE", "shallow/partial clones are refused: the object set is incomplete", "inspecting repository", { dir: top });
  const format = (await gitRevParse(top, "--show-object-format")).trim();
  if (format !== "sha1") fail("GIT_OBJECT_FORMAT_UNSUPPORTED", `object format ${format} is not supported in V0 (sha1 only)`, "inspecting repository", { object_format: format });
  for (const [file, code, what] of [
    [join(commonDir, "objects", "info", "alternates"), "GITVAULT_ALTERNATES_UNSUPPORTED", "objects/info/alternates"],
    [join(commonDir, "info", "grafts"), "GITVAULT_GRAFTS_UNSUPPORTED", "info/grafts"],
  ] as const) {
    if (existsSync(file)) fail(code, `${what} is present; alternates/grafts are refused so the captured object set is exactly this repository's`, "inspecting repository", { file });
  }
  // sparse checkout: the config bit or the sparse-checkout file
  const sparse = await hardenedGit(top, ["config", "--bool", "--get", "core.sparseCheckout"], { okStatuses: [1] });
  if (sparse.text().trim() === "true" || existsSync(join(gitDir, "info", "sparse-checkout"))) fail("GITVAULT_SPARSE_CHECKOUT", "sparse checkouts are refused: the work tree is not the whole tree", "inspecting repository", { dir: top });
  // repository config includes — git applies them before -c; refuse by name
  const cfg = await hardenedGit(top, ["config", "--file", join(commonDir, "config"), "--list", "--name-only"], { okStatuses: [1] });
  for (const name of cfg.lines()) {
    const lower = name.toLowerCase();
    if (lower.startsWith("include.") || lower.startsWith("includeif.")) fail("GITVAULT_CONFIG_INCLUDE_REFUSED", `repository config carries ${name}; include/includeIf is refused by name`, "inspecting repository", { key: name });
  }
  // submodules: .gitmodules or gitlinks in the index
  if (existsSync(join(top, ".gitmodules"))) fail("GITVAULT_SUBMODULES_UNSUPPORTED", ".gitmodules present; submodules are not supported in V0", "inspecting repository", { dir: top });
  const gitlinks = (await hardenedGit(top, ["ls-files", "-s", "-z"])).nul().filter((l) => l.startsWith("160000 "));
  if (gitlinks.length > 0) fail("GITVAULT_SUBMODULES_UNSUPPORTED", "the index contains gitlinks; submodules are not supported in V0", "inspecting repository", { paths: gitlinks.map((l) => l.split("\t")[1]) });
  // HEAD
  const symref = await hardenedGit(top, ["symbolic-ref", "-q", "HEAD"], { okStatuses: [1] });
  const resolved = await hardenedGit(top, ["rev-parse", "-q", "--verify", "HEAD^{commit}"], { okStatuses: [1] });
  const resolvedOid = resolved.status === 0 ? resolved.text().trim() : null;
  let head: GitvaultRepositoryInspection["head"];
  if (symref.status === 0) {
    const ref = symref.text().trim();
    if (!ref.startsWith("refs/heads/")) fail("REFNAME_UNSUPPORTED", `HEAD points at ${ref}, which is not a refs/heads/* branch`, "inspecting repository", { ref });
    head = { kind: "symref", ref, resolved_oid: resolvedOid };
  } else {
    if (!resolvedOid) fail("GITVAULT_NOT_A_REPOSITORY", "HEAD is neither a symbolic ref nor a commit", "inspecting repository", { dir: top });
    head = { kind: "detached", oid: resolvedOid, resolved_oid: resolvedOid };
  }
  const unmerged = [...new Set((await hardenedGit(top, ["ls-files", "-u", "-z"])).nul().map((l) => l.split("\t")[1]!))];
  return { top_level: top, git_dir: gitDir, git_common_dir: commonDir, object_format: "sha1", head, unmerged_paths: unmerged };
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

export interface GitvaultSnapshotOptions {
  /** The work tree (any directory inside it). */
  dir: string;
  /** Discovery environment; defaults to the process's HOME / XDG_CONFIG_HOME. */
  env?: GitConfigDiscoveryEnv;
  /** When set, also move the LOCAL `refs/run402/deploys/latest` to the snapshot (keeps a synthetic commit reachable across `git gc`). Default true. */
  update_local_deploy_ref?: boolean;
  /** Commit message for a synthetic commit. */
  message?: string;
  /** Clock (synthetic commit timestamps). */
  now?: () => Date;
  /**
   * Capture a dirty tree anyway. Default `false` — a dirty tree (any
   * modified/staged tracked path, or any untracked-not-ignored path) is
   * refused with `SNAPSHOT_DIRTY_TREE` before any object is created, in
   * BOTH capture lanes (manual `repos snapshot` and the deploy-lane
   * capture). Has no effect on a clean tree, and never overrides
   * `SNAPSHOT_CONFLICTED_INDEX` (an unmerged index is checked first and
   * refuses regardless). See {@link GitvaultSnapshot.modified_captured} /
   * {@link GitvaultSnapshot.untracked_captured} for the disclosure this
   * produces once set.
   */
  allowDirty?: boolean;
}

/** How many dirty-tree paths `SNAPSHOT_DIRTY_TREE`'s `details.modified`/`details.untracked` list before capping. */
export const SNAPSHOT_DIRTY_TREE_LIST_CAP = 500;

function cappedPathList(paths: string[]): { list: string[]; more: number } {
  if (paths.length <= SNAPSHOT_DIRTY_TREE_LIST_CAP) return { list: paths, more: 0 };
  return { list: paths.slice(0, SNAPSHOT_DIRTY_TREE_LIST_CAP), more: paths.length - SNAPSHOT_DIRTY_TREE_LIST_CAP };
}

export interface GitvaultSnapshotRefusalPath {
  path: string;
  filter: string;
}

export interface GitvaultSnapshot {
  /** `head` = the tree was clean and the snapshot IS `HEAD`; `synthetic` = a commit was created for a dirty tree. */
  kind: "head" | "synthetic";
  /** The snapshot commit oid — the `gitvault_commit`. */
  oid: string;
  /** The tree the snapshot resolves to. */
  tree_oid: string;
  /** What `HEAD` was at capture — symref (possibly unborn) or detached. */
  head: GitvaultHeadTarget;
  /** `HEAD`'s commit when it had one. */
  head_oid: string | null;
  /** Paths included in a synthetic commit (tracked + untracked-not-ignored); empty for `head`. */
  paths: string[];
  /**
   * The CAPTURED SET, always populated for both kinds: every tracked or
   * untracked-but-not-ignored path present on disk at capture, with the mode
   * and the raw-bytes oid the snapshot corresponds to. This is the set the
   * correspondence check re-derives — NOT the whole working directory, and
   * deliberately NOT gitignored build output (see {@link capturedSetDigest}).
   */
  captured: GitvaultCapturedFile[];
  /** `sha256` over {@link captured} — the value re-derived before a plan commits. */
  captured_digest: string;
  /** The global excludes file honored (as data), when one existed. */
  global_excludes_path: string | null;
  top_level: string;
  /**
   * Disclosure for an `allowDirty: true` capture: tracked paths that were
   * modified/staged relative to `HEAD` (or, on an unborn `HEAD`, every
   * populated index path) and got swept into the capture. Empty for a clean
   * tree (`kind: "head"`) — there was nothing to sweep in.
   */
  modified_captured: string[];
  /**
   * Disclosure for an `allowDirty: true` capture: untracked-not-ignored
   * paths that got swept into the capture. Empty for a clean tree
   * (`kind: "head"`).
   */
  untracked_captured: string[];
}

/** One member of the captured set: path, mode, and the oid of its RAW bytes (`--no-filters`). */
export interface GitvaultCapturedFile {
  path: string;
  mode: "100644" | "100755" | "120000";
  oid: string;
}

type Entry = GitvaultCapturedFile;

function isExecutable(mode: number): boolean { return (mode & 0o111) !== 0; }

/**
 * Stat every candidate path, restricted to what is actually present on disk
 * (a deleted/absent path is silently dropped — that IS the encoding of a
 * deletion). Sizes ride along so the caller can enforce the per-object cap
 * before any object is written. Shared by every capture lane (the ordinary
 * tracked-plus-untracked enumeration below, and the handoff capture's
 * tracked-only / untracked-only enumerations) so they can never drift into
 * disagreeing about what "present on disk" means for one path.
 */
function statPresentPaths(top: string, candidates: string[]): Array<{ path: string; mode: Entry["mode"]; size: number }> {
  const present: Array<{ path: string; mode: Entry["mode"]; size: number }> = [];
  for (const p of candidates) {
    const abs = join(top, p);
    let st;
    try { st = lstatSync(abs); } catch { continue; } // deleted in the work tree → absent from the snapshot
    if (st.isSymbolicLink()) present.push({ path: p, mode: "120000", size: st.size });
    else if (st.isFile()) present.push({ path: p, mode: isExecutable(st.mode) ? "100755" : "100644", size: st.size });
    // directories (e.g. nested repos) and specials are skipped — git would not track them either
  }
  return present;
}

/**
 * Enumerate the captured set: tracked ∪ untracked-but-not-ignored, restricted
 * to what is actually present on disk.
 *
 * This is the ONE enumeration both the capture and the correspondence check
 * use, so the two can never drift into disagreeing about what "the captured
 * set" means — which would show up as a deploy that refuses an untouched tree.
 */
async function enumerateCapturedPaths(
  top: string,
  excludeArgs: string[],
  untracked?: string[],
): Promise<Array<{ path: string; mode: Entry["mode"]; size: number }>> {
  const others = untracked ?? (await hardenedGit(top, ["ls-files", "-z", "--others", "--exclude-standard", ...excludeArgs])).nul();
  const tracked = (await hardenedGit(top, ["ls-files", "-z", "--cached"])).nul();
  const candidates = [...new Set([...tracked, ...others])].sort();
  return statPresentPaths(top, candidates);
}

/**
 * Hash the enumerated set's RAW bytes (`--no-filters`, so no clean/smudge
 * command is ever started). `write` persists the blobs — the capture needs
 * them to build a tree; the correspondence check does not and must not.
 */
async function hashCapturedPaths(
  top: string,
  present: Array<{ path: string; mode: Entry["mode"]; size: number }>,
  write: boolean,
  context: string,
): Promise<GitvaultCapturedFile[]> {
  const entries: Entry[] = [];
  const writeArgs = write ? ["-w"] : [];
  const regular = present.filter((e) => e.mode !== "120000");
  if (regular.length > 0) {
    const out = await hardenedGit(top, ["hash-object", ...writeArgs, "--no-filters", "--stdin-paths"], { input: regular.map((e) => e.path).join("\n") + "\n" });
    const oids = out.lines();
    if (oids.length !== regular.length) fail("GIT_COMMAND_FAILED", "hash-object returned a different number of ids than paths", context);
    regular.forEach((e, i) => entries.push({ path: e.path, mode: e.mode, oid: oids[i]! }));
  }
  for (const e of present.filter((x) => x.mode === "120000")) {
    const target = readlinkSync(join(top, e.path));
    const out = await hardenedGit(top, ["hash-object", ...writeArgs, "--no-filters", "--stdin"], { input: target });
    entries.push({ path: e.path, mode: "120000", oid: out.text().trim() });
  }
  // regular files were hashed in one batch and symlinks after them — restore path order.
  entries.sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
  return entries;
}

/**
 * `sha256` over the captured set, in git's own index-info line form
 * (`<mode> <oid>\t<path>\n`, path-sorted) so the serialization is the one the
 * tree is built from rather than a second, drifting encoding.
 *
 * WHAT THIS COVERS, EXACTLY: the captured source set — tracked plus
 * untracked-but-not-ignored. It does NOT cover gitignored paths, so a build
 * that rewrites `dist/` between capture and commit changes nothing here, by
 * design: a project with a build step would otherwise be undeployable. The
 * guarantee this digest buys is "the captured source did not change while the
 * artifacts were produced", NOT "the artifacts are a function of that source".
 */
export function capturedSetDigest(files: GitvaultCapturedFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
  return sha256Hex(new TextEncoder().encode(sorted.map((e) => `${e.mode} ${e.oid}\t${e.path}\n`).join("")));
}

/**
 * Re-derive the captured set from the work tree, without writing any object.
 *
 * `global_excludes_path` is the file the capture honored — passed through
 * rather than rediscovered, so the comparison is about the TREE and cannot be
 * perturbed by the user's git config changing mid-deploy.
 */
export async function deriveCapturedSet(options: { top_level: string; global_excludes_path?: string | null }): Promise<GitvaultCapturedFile[]> {
  const excludeArgs = options.global_excludes_path ? ["--exclude-from", options.global_excludes_path] : [];
  const present = await enumerateCapturedPaths(options.top_level, excludeArgs);
  return hashCapturedPaths(options.top_level, present, false, "re-deriving the captured set");
}

/** What changed between two captured sets. Empty on every list means the set is byte-identical. */
export interface GitvaultCapturedSetDrift {
  added: string[];
  removed: string[];
  modified: string[];
}

/** Name the paths that moved — added, removed, or changed content/mode. */
export function diffCapturedSets(before: GitvaultCapturedFile[], after: GitvaultCapturedFile[]): GitvaultCapturedSetDrift {
  const b = new Map(before.map((e) => [e.path, e]));
  const a = new Map(after.map((e) => [e.path, e]));
  const drift: GitvaultCapturedSetDrift = { added: [], removed: [], modified: [] };
  for (const [path, entry] of a) {
    const prior = b.get(path);
    if (!prior) drift.added.push(path);
    else if (prior.oid !== entry.oid || prior.mode !== entry.mode) drift.modified.push(path);
  }
  for (const path of b.keys()) if (!a.has(path)) drift.removed.push(path);
  drift.added.sort();
  drift.removed.sort();
  drift.modified.sort();
  return drift;
}

/** True when nothing in the captured set moved. */
export function capturedSetUnchanged(drift: GitvaultCapturedSetDrift): boolean {
  return drift.added.length === 0 && drift.removed.length === 0 && drift.modified.length === 0;
}

/**
 * Capture the work tree per the §6.6 policy. Branches, index, and work tree
 * are left byte-identical; a synthetic commit lives only in the object
 * database (plus the local deploy ref when enabled).
 */
export async function captureSnapshot(options: GitvaultSnapshotOptions): Promise<GitvaultSnapshot> {
  const repo = await inspectRepository(options.dir);
  const top = repo.top_level;
  if (repo.unmerged_paths.length > 0) {
    fail("SNAPSHOT_CONFLICTED_INDEX", `the index has unmerged paths; resolve the merge conflict, then redeploy`, "capturing snapshot", { paths: repo.unmerged_paths });
  }
  // Ignore authority — discovered and read AS DATA before git sees anything.
  const excludes = discoverGlobalExcludes(options.env);
  const excludeArgs = excludes.path ? ["--exclude-from", excludes.path] : [];

  const headTarget: GitvaultHeadTarget = repo.head.kind === "symref" ? { kind: "symref", ref: repo.head.ref } : { kind: "detached", oid: repo.head.oid };
  const headOid = repo.head.resolved_oid;

  // Dirty detection: index/worktree vs HEAD, plus untracked-not-ignored.
  // Both lists are collected in full (not just a boolean) — SNAPSHOT_DIRTY_TREE
  // discloses them below, and an `allowDirty` capture discloses them again as
  // `modified_captured` / `untracked_captured` on the result.
  const untracked = (await hardenedGit(top, ["ls-files", "-z", "--others", "--exclude-standard", ...excludeArgs])).nul();
  let modified: string[];
  if (!headOid) {
    modified = (await hardenedGit(top, ["ls-files", "-z"])).nul(); // unborn HEAD with a populated index — every entry is new
  } else {
    await hardenedGit(top, ["update-index", "-q", "--refresh"], { okStatuses: [1] });
    modified = (await hardenedGit(top, ["diff-index", "--name-only", "-z", "HEAD", "--"])).nul();
  }
  const dirty = untracked.length > 0 || modified.length > 0;

  // Fail fast and free: this refusal fires BEFORE any object is created,
  // hashed, or uploaded — Tal's decision "help people not make mistakes"
  // applies to both capture lanes (manual `repos snapshot` and the
  // deploy-lane capture), and to `--dry-run` (which reaches this same
  // function — a preview that hid the refusal would lie).
  if (dirty && options.allowDirty !== true) {
    const modifiedCap = cappedPathList(modified);
    const untrackedCap = cappedPathList(untracked);
    fail(
      "SNAPSHOT_DIRTY_TREE",
      `the work tree is dirty (${modified.length} modified/staged tracked path(s), ${untracked.length} untracked-not-ignored path(s)) — refusing to capture by default. Commit your changes and retry, or capture the tree as-is with allowDirty:true (SDK) / --allow-dirty (CLI); the result will disclose exactly what was swept in.`,
      "capturing snapshot",
      {
        modified: modifiedCap.list,
        modified_more: modifiedCap.more,
        untracked: untrackedCap.list,
        untracked_more: untrackedCap.more,
      },
      [
        { type: "edit_request", why: "Commit your changes, then retry." },
        { type: "edit_request", why: "Or capture the tree as-is: pass allowDirty:true (SDK) / --allow-dirty (CLI)." },
      ],
    );
  }

  if (!dirty && headOid) {
    const tree = (await hardenedGit(top, ["rev-parse", "HEAD^{tree}"])).text().trim();
    // The captured set is recorded for a clean tree too, through the SAME
    // enumerate+hash path the dirty branch uses. Reading it off `HEAD`'s tree
    // instead would be cheaper and wrong: a filtered path's committed blob is
    // the CLEANED content while the work tree holds the SMUDGED bytes, so an
    // untouched tree would re-derive differently and refuse its own deploy.
    const cleanPresent = await enumerateCapturedPaths(top, excludeArgs, untracked);
    const cleanCaptured = await hashCapturedPaths(top, cleanPresent, false, "capturing snapshot");
    return { kind: "head", oid: headOid, tree_oid: tree, head: headTarget, head_oid: headOid, paths: [], captured: cleanCaptured, captured_digest: capturedSetDigest(cleanCaptured), global_excludes_path: excludes.path, top_level: top, modified_captured: [], untracked_captured: [] };
  }

  // Synthetic commit: tracked paths present on disk + untracked-not-ignored.
  // Reached only when `dirty` (an unborn HEAD with an empty index is NOT
  // dirty and falls through to here too — `headOid` is null, `modified`/
  // `untracked` are both empty, and the loop below simply commits nothing).
  const present = await enumerateCapturedPaths(top, excludeArgs, untracked);
  // Size cap before any object is written.
  const oversize = present.find((e) => e.size > GITVAULT_MAX_GIT_OBJECT_BYTES);
  if (oversize) {
    fail("GIT_OBJECT_TOO_LARGE", `${oversize.path} is ${oversize.size} bytes; the per-object cap is ${GITVAULT_MAX_GIT_OBJECT_BYTES} bytes (200 MiB)`, "capturing snapshot", { path: oversize.path, size_bytes: String(oversize.size), cap_bytes: String(GITVAULT_MAX_GIT_OBJECT_BYTES) });
  }
  // Filter detection over EVERY included path (LFS is a filter) — refuse by name, never start one.
  const active = await detectActiveFilters(top, present.map((e) => e.path));
  if (active.length > 0) {
    const lfs = active.filter((a) => a.filter === "lfs");
    const code = lfs.length > 0 ? "GITVAULT_LFS_UNSUPPORTED" : "GITVAULT_FILTER_ACTIVE";
    fail(code, `${active.length} captured path(s) have an active clean/smudge filter (${[...new Set(active.map((a) => a.filter))].join(", ")}); gitvault never runs filters, so the capture is refused by name — first: ${active[0]!.path}`, "capturing snapshot", { paths: active });
  }
  // Hash raw bytes with filters structurally disabled (`-w`: the tree below needs the blobs).
  const entries: Entry[] = await hashCapturedPaths(top, present, true, "capturing snapshot");
  // Build the tree in a TEMPORARY index so the user's index stays byte-identical.
  const tmp = mkdtempSync(join(tmpdir(), "run402-gitvault-snapshot-"));
  try {
    const indexFile = join(tmp, "index");
    const info = entries.map((e) => `${e.mode} ${e.oid}\t${e.path}\n`).join("");
    await hardenedGit(top, ["update-index", "--index-info"], { input: info, env: { GIT_INDEX_FILE: indexFile } });
    const tree = (await hardenedGit(top, ["write-tree"], { env: { GIT_INDEX_FILE: indexFile } })).text().trim();
    const when = Math.floor((options.now ?? (() => new Date()))().getTime() / 1000);
    const dateEnv = { GIT_AUTHOR_DATE: `${when} +0000`, GIT_COMMITTER_DATE: `${when} +0000` };
    const parentArgs = headOid ? ["-p", headOid] : [];
    const commit = (await hardenedGit(top, ["commit-tree", tree, ...parentArgs, "-m", options.message ?? "run402 gitvault snapshot (synthetic commit of the work tree)"], { env: dateEnv })).text().trim();
    if (options.update_local_deploy_ref !== false) {
      await hardenedGit(top, ["update-ref", GITVAULT_DEPLOY_REF, commit]);
    }
    // Disclosure (allowDirty override): restrict `modified`/`untracked` to
    // paths that actually landed in the captured set — a `modified` path
    // that was deleted in the work tree is real drift but is not itself
    // CAPTURED (it is simply absent, like any other deleted path).
    const presentPaths = new Set(present.map((e) => e.path));
    return {
      kind: "synthetic", oid: commit, tree_oid: tree, head: headTarget, head_oid: headOid,
      paths: entries.map((e) => e.path), captured: entries, captured_digest: capturedSetDigest(entries),
      global_excludes_path: excludes.path, top_level: top,
      modified_captured: modified.filter((p) => presentPaths.has(p)),
      untracked_captured: untracked.filter((p) => presentPaths.has(p)),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** `git check-attr filter` over paths; returns every path whose `filter` attribute is set (LFS included). */
export async function detectActiveFilters(top: string, paths: string[]): Promise<GitvaultSnapshotRefusalPath[]> {
  if (paths.length === 0) return [];
  const out = await hardenedGit(top, ["check-attr", "-z", "--stdin", "filter"], { input: paths.join("\0") + "\0" });
  const parts = out.nul();
  const active: GitvaultSnapshotRefusalPath[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const value = parts[i + 2]!;
    if (value !== "unspecified" && value !== "unset") active.push({ path: parts[i]!, filter: value });
  }
  return active;
}

// ─── Handoff capture (kygit-handoff design D1/D10) ──────────────────────────

/**
 * Sensitive untracked-path denylist (design D10, verbatim). Applies to the
 * UNTRACKED set only — a tracked file is the user's own committed choice and
 * is never filtered by this list. `--include-sensitive <glob>` re-admits a
 * named path by matching the SAME glob grammar against the candidate.
 */
export const GITVAULT_HANDOFF_SENSITIVE_DENYLIST: readonly string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "id_rsa*",
  "id_ed25519*",
  "id_ecdsa*",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".git-credentials",
  "*.tfstate*",
  "*credentials*.json",
  ".aws/**",
  ".ssh/**",
  ".gnupg/**",
  "*.secret",
  "secrets.*",
];

function escapeGlobLiteral(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** `*` → any run of non-`/` chars, `**` → any run of chars (incl. `/`), `?` → one non-`/` char, everything else literal. */
function globToRegExpSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") { out += ".*"; i++; } else out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += escapeGlobLiteral(c);
    }
  }
  return out;
}

/**
 * A slash-free glob matches the path's BASENAME at any depth (gitignore's
 * "no slash" rule). A glob ending `/**` (e.g. `.aws/**`) matches the named
 * directory component at ANY depth in the tree, plus everything under it —
 * a deliberately broader-than-gitignore reading for a credential-directory
 * denylist, where over-excluding is the safe failure mode. Any other
 * slash-bearing glob matches the full relative path exactly.
 */
export function globMatchesGitPath(glob: string, relPath: string): boolean {
  if (!glob.includes("/")) {
    const re = new RegExp(`^${globToRegExpSource(glob)}$`);
    const base = relPath.slice(relPath.lastIndexOf("/") + 1);
    return re.test(base);
  }
  if (glob.endsWith("/**")) {
    const dir = glob.slice(0, -3);
    const dirRe = new RegExp(`(^|/)${globToRegExpSource(dir)}(/|$)`);
    return dirRe.test(relPath);
  }
  const re = new RegExp(`^${globToRegExpSource(glob)}$`);
  return re.test(relPath);
}

/** True iff `relPath` (an untracked-not-ignored path) matches the sensitive denylist and is not re-admitted by `includeSensitive`. */
export function isHandoffSensitivePath(relPath: string, includeSensitive: readonly string[] = []): boolean {
  if (includeSensitive.some((g) => globMatchesGitPath(g, relPath))) return false;
  return GITVAULT_HANDOFF_SENSITIVE_DENYLIST.some((g) => globMatchesGitPath(g, relPath));
}

/** What {@link GitvaultHandoffCaptureOptions.message} learns once capture figures are known — everything a Handoff Note's `capture` block needs, before the outer commit exists. */
export interface GitvaultHandoffCaptureStats {
  base_head_oid: string;
  /** `HEAD`'s symref name (`refs/heads/<branch>`, stripped) — `null` on a detached HEAD. */
  branch: string | null;
  modified_captured: string[];
  untracked_captured: string[];
  sensitive_excluded: string[];
  ignored_not_transferred_count: number;
}

export interface GitvaultHandoffCaptureOptions {
  /** The work tree (any directory inside it). */
  dir: string;
  env?: GitConfigDiscoveryEnv;
  /**
   * The outer commit's message (the Handoff Note). A plain string is used
   * verbatim (the caller has already composed and secret-scanned it). A
   * FUNCTION is called with the real capture figures right before the
   * outer `commit-tree` — the one point at which a Handoff Note's
   * `capture` block can be filled with true numbers, since the note (and
   * the commit that carries it) cannot exist before those numbers are
   * known. Throwing inside it (the client-side secret scan) aborts the
   * capture before the outer commit is written; the two throwaway parent
   * commits (index/untracked) are already unreachable garbage at that
   * point, exactly as if the capture had never run.
   */
  message: string | ((stats: GitvaultHandoffCaptureStats) => string);
  now?: () => Date;
  /** Re-admit named untracked paths the sensitive denylist would otherwise exclude. */
  includeSensitive?: string[];
}

/**
 * A stash-shaped checkpoint (design D1): one synthetic commit, ALWAYS
 * created (a clean tree still produces it — there is one shape, one code
 * path). `oid`'s tree is the worktree state of TRACKED paths only; its
 * three parents are `base_head_oid` (parent 1), `index_commit_oid` (parent
 * 2, tree = the real index), and `untracked_commit_oid` (parent 3,
 * parentless, tree = the admitted untracked set — the EMPTY tree when
 * nothing untracked survives the denylist). Restore is `git clone` at
 * `base_head_oid` then `git stash apply --index <oid>`.
 */
export interface GitvaultHandoffSnapshot {
  oid: string;
  tree_oid: string;
  base_head_oid: string;
  index_commit_oid: string;
  untracked_commit_oid: string;
  head: GitvaultHeadTarget;
  top_level: string;
  /** Tracked paths whose on-disk content differs from `base_head_oid`'s tree (staged, unstaged, or both) and are present in `tree_oid`. */
  modified_captured: string[];
  /** Untracked-not-ignored paths admitted into `untracked_commit_oid`'s tree (denylist already applied). */
  untracked_captured: string[];
  /** Untracked-not-ignored paths excluded by the sensitive denylist (before any `includeSensitive` re-admission). */
  sensitive_excluded: string[];
  /** Ignored (gitignore/exclude) files present on disk — never transferred, counted only. */
  ignored_not_transferred_count: number;
  captured: GitvaultCapturedFile[];
  captured_digest: string;
  global_excludes_path: string | null;
}

/**
 * Capture a stash-shaped handoff checkpoint. Reuses every hardened-execution
 * guarantee `captureSnapshot` already provides (filter-free hashing, frozen
 * ignore authority, refusal-by-name for conflicted/linked/submodule/sparse/
 * shallow/LFS layouts) via {@link inspectRepository} + {@link
 * detectActiveFilters}; the shape below is the ONLY thing new.
 */
export async function captureHandoffSnapshot(options: GitvaultHandoffCaptureOptions): Promise<GitvaultHandoffSnapshot> {
  const repo = await inspectRepository(options.dir);
  const top = repo.top_level;
  if (repo.unmerged_paths.length > 0) {
    fail("SNAPSHOT_CONFLICTED_INDEX", `the index has unmerged paths; resolve the merge conflict, then hand off`, "capturing handoff snapshot", { paths: repo.unmerged_paths });
  }
  if (!repo.head.resolved_oid) {
    fail("HANDOFF_NO_BASE_COMMIT", "the repository has no commits yet (unborn HEAD) — a handoff needs a base commit to clone from; make an initial commit first", "capturing handoff snapshot", { dir: top });
  }
  const baseHeadOid = repo.head.resolved_oid;
  const headTarget: GitvaultHeadTarget = repo.head.kind === "symref" ? { kind: "symref", ref: repo.head.ref } : { kind: "detached", oid: repo.head.oid };

  const excludes = discoverGlobalExcludes(options.env);
  const excludeArgs = excludes.path ? ["--exclude-from", excludes.path] : [];

  const trackedList = (await hardenedGit(top, ["ls-files", "-z", "--cached"])).nul();
  const untrackedList = (await hardenedGit(top, ["ls-files", "-z", "--others", "--exclude-standard", ...excludeArgs])).nul();
  const ignoredList = (await hardenedGit(top, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", ...excludeArgs])).nul();
  await hardenedGit(top, ["update-index", "-q", "--refresh"], { okStatuses: [1] });
  const modified = (await hardenedGit(top, ["diff-index", "--name-only", "-z", "HEAD", "--"])).nul();

  const includeSensitive = options.includeSensitive ?? [];
  const sensitiveExcluded: string[] = [];
  const admittedUntracked: string[] = [];
  for (const p of untrackedList) {
    if (isHandoffSensitivePath(p, includeSensitive)) sensitiveExcluded.push(p);
    else admittedUntracked.push(p);
  }

  const trackedPresent = statPresentPaths(top, trackedList);
  const untrackedPresent = statPresentPaths(top, admittedUntracked);

  const oversize = [...trackedPresent, ...untrackedPresent].find((e) => e.size > GITVAULT_MAX_GIT_OBJECT_BYTES);
  if (oversize) {
    fail("GIT_OBJECT_TOO_LARGE", `${oversize.path} is ${oversize.size} bytes; the per-object cap is ${GITVAULT_MAX_GIT_OBJECT_BYTES} bytes (200 MiB)`, "capturing handoff snapshot", { path: oversize.path, size_bytes: String(oversize.size), cap_bytes: String(GITVAULT_MAX_GIT_OBJECT_BYTES) });
  }
  const allIncludedPaths = [...trackedPresent.map((e) => e.path), ...untrackedPresent.map((e) => e.path)];
  const active = await detectActiveFilters(top, allIncludedPaths);
  if (active.length > 0) {
    const lfs = active.filter((a) => a.filter === "lfs");
    const code = lfs.length > 0 ? "GITVAULT_LFS_UNSUPPORTED" : "GITVAULT_FILTER_ACTIVE";
    fail(code, `${active.length} captured path(s) have an active clean/smudge filter (${[...new Set(active.map((a) => a.filter))].join(", ")}); gitvault never runs filters, so the capture is refused by name — first: ${active[0]!.path}`, "capturing handoff snapshot", { paths: active });
  }

  const trackedEntries = await hashCapturedPaths(top, trackedPresent, true, "capturing handoff snapshot");
  const untrackedEntries = await hashCapturedPaths(top, untrackedPresent, true, "capturing handoff snapshot");

  const when = Math.floor((options.now ?? (() => new Date()))().getTime() / 1000);
  const dateEnv = { GIT_AUTHOR_DATE: `${when} +0000`, GIT_COMMITTER_DATE: `${when} +0000` };

  async function buildTree(entries: Entry[]): Promise<string> {
    const tmp = mkdtempSync(join(tmpdir(), "run402-gitvault-handoff-"));
    try {
      const indexFile = join(tmp, "index");
      const info = entries.map((e) => `${e.mode} ${e.oid}\t${e.path}\n`).join("");
      await hardenedGit(top, ["update-index", "--index-info"], { input: info, env: { GIT_INDEX_FILE: indexFile } });
      return (await hardenedGit(top, ["write-tree"], { env: { GIT_INDEX_FILE: indexFile } })).text().trim();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // parent 1: base HEAD (already exists — no object to build).
  // parent 2: the index commit — tree = the REAL index (no synthetic
  // rebuild needed, its blobs are already objects), parent = base HEAD
  // (matches real `git stash`'s own index-commit shape, verified against
  // git 2.43's plumbing output).
  const indexTreeOid = (await hardenedGit(top, ["write-tree"])).text().trim();
  const indexCommitOid = (await hardenedGit(
    top,
    ["commit-tree", indexTreeOid, "-p", baseHeadOid, "-m", "gitvault handoff: index"],
    { env: dateEnv },
  )).text().trim();

  // parent 3: the untracked commit — parentless, tree = admitted untracked
  // set (the empty tree when nothing survives the denylist).
  const untrackedTreeOid = await buildTree(untrackedEntries);
  const untrackedCommitOid = (await hardenedGit(
    top,
    ["commit-tree", untrackedTreeOid, "-m", "gitvault handoff: untracked"],
    { env: dateEnv },
  )).text().trim();

  const trackedPresentSet = new Set(trackedPresent.map((e) => e.path));
  const untrackedPresentSet = new Set(untrackedPresent.map((e) => e.path));
  const modifiedCaptured = modified.filter((p) => trackedPresentSet.has(p));
  const untrackedCaptured = admittedUntracked.filter((p) => untrackedPresentSet.has(p));
  const stats: GitvaultHandoffCaptureStats = {
    base_head_oid: baseHeadOid,
    branch: headTarget.kind === "symref" ? headTarget.ref.replace(/^refs\/heads\//, "") : null,
    modified_captured: modifiedCaptured,
    untracked_captured: untrackedCaptured,
    sensitive_excluded: [...sensitiveExcluded].sort(),
    ignored_not_transferred_count: ignoredList.length,
  };
  const message = typeof options.message === "function" ? options.message(stats) : options.message;

  // The outer commit: tree = tracked worktree state; three parents; the
  // Handoff Note as its message. ALWAYS created — a clean tree still
  // produces this commit (one shape, one code path).
  const worktreeTreeOid = await buildTree(trackedEntries);
  const outerOid = (await hardenedGit(
    top,
    ["commit-tree", worktreeTreeOid, "-p", baseHeadOid, "-p", indexCommitOid, "-p", untrackedCommitOid, "-m", message],
    { env: dateEnv },
  )).text().trim();

  const captured = [...trackedEntries, ...untrackedEntries];

  return {
    oid: outerOid,
    tree_oid: worktreeTreeOid,
    base_head_oid: baseHeadOid,
    index_commit_oid: indexCommitOid,
    untracked_commit_oid: untrackedCommitOid,
    head: headTarget,
    top_level: top,
    modified_captured: stats.modified_captured,
    untracked_captured: stats.untracked_captured,
    sensitive_excluded: stats.sensitive_excluded,
    ignored_not_transferred_count: stats.ignored_not_transferred_count,
    captured,
    captured_digest: capturedSetDigest(captured),
    global_excludes_path: excludes.path,
  };
}

// ─── Materialization (the deploy lane builds from THIS, never the work tree) ─

/**
 * Check out `oid`'s tree into `targetDir` through a temporary index
 * (`read-tree` + `checkout-index`) — filter-free, hook-free, and isolated
 * from the mutable work tree. Returns the absolute target directory.
 */
export async function materializeSnapshot(repoDir: string, oid: string, targetDir?: string): Promise<string> {
  if (!GITVAULT_OID40_RE.test(oid)) fail("GITVAULT_BAD_OID", `not a 40-hex oid: ${oid}`, "materializing snapshot");
  const top = (await hardenedGit(resolve(repoDir), ["rev-parse", "--show-toplevel"])).text().trim();
  const target = targetDir ? resolve(targetDir) : mkdtempSync(join(tmpdir(), "run402-gitvault-materialize-"));
  mkdirSync(target, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "run402-gitvault-index-"));
  try {
    const indexFile = join(tmp, "index");
    await hardenedGit(top, ["read-tree", `${oid}^{tree}`], { env: { GIT_INDEX_FILE: indexFile } });
    await hardenedGit(top, ["-c", "core.autocrlf=false", "checkout-index", "-a", "-f", `--prefix=${target.endsWith("/") ? target : target + "/"}`], { env: { GIT_INDEX_FILE: indexFile } });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return target;
}

// ─── Commitment ──────────────────────────────────────────────────────────────

/** `snapshot_oid_hmac` = HMAC(K_digest("snapshot_oid"), JCS({oid, format:"sha1"})) — the keyed commitment the platform compares without ever seeing the oid. */
export function snapshotCommitment(kRepo: Uint8Array, repoId: string, epoch: string, oid: string): string {
  return keyedCommitment(deriveDigestKey(kRepo, repoId, epoch, "snapshot_oid"), snapshotOidContent(oid));
}

/** The client-side `gitvault_commit` line — printed ALWAYS; commit ids never reach the platform. */
export function gitvaultCommitLine(snapshot: Pick<GitvaultSnapshot, "oid" | "kind">): string {
  return `gitvault_commit ${snapshot.oid}${snapshot.kind === "synthetic" ? " (synthetic)" : ""}`;
}

/** Object sizes for a set of oids (`cat-file --batch-check`), for the per-object cap on tracked history. */
export async function findOversizeObjects(repoDir: string, tips: string[], cap = GITVAULT_MAX_GIT_OBJECT_BYTES): Promise<Array<{ oid: string; size_bytes: number }>> {
  if (tips.length === 0) return [];
  const objects = (await hardenedGit(repoDir, ["rev-list", "--objects", ...tips])).lines().map((l) => l.split(" ")[0]!);
  const out = await hardenedGit(repoDir, ["cat-file", "--batch-check=%(objectname) %(objectsize)"], { input: objects.join("\n") + "\n" });
  const over: Array<{ oid: string; size_bytes: number }> = [];
  for (const line of out.lines()) {
    const [oid, size] = line.split(" ");
    if (oid && size && Number(size) > cap) over.push({ oid, size_bytes: Number(size) });
  }
  return over;
}

/** True iff `ancestor` is reachable from `descendant` (`merge-base --is-ancestor`). */
export async function isAncestor(repoDir: string, ancestor: string, descendant: string): Promise<boolean> {
  const r = await hardenedGit(repoDir, ["merge-base", "--is-ancestor", ancestor, descendant], { okStatuses: [1] });
  return r.status === 0;
}

/** Does the object exist locally? */
export async function hasObject(repoDir: string, oid: string): Promise<boolean> {
  const r = await hardenedGit(repoDir, ["cat-file", "-e", `${oid}^{object}`], { okStatuses: [1, 128] });
  return r.status === 0;
}

/**
 * Which of `oids` exist locally — ONE `cat-file --batch-check` process for
 * the whole set (gitvault-delta-fetch task 3.1), identical per-oid
 * semantics to {@link hasObject}. `--batch-check` answers `<oid> <type>
 * <size>` for a present object and `<oid> missing` otherwise, one line per
 * input line, so presence is exactly "second column is not `missing`".
 */
export async function hasObjects(repoDir: string, oids: string[]): Promise<Set<string>> {
  if (oids.length === 0) return new Set();
  const input = new TextEncoder().encode(oids.map((o) => `${o}\n`).join(""));
  const r = await hardenedGit(repoDir, ["cat-file", "--batch-check"], { input, okStatuses: [1, 128] });
  const present = new Set<string>();
  for (const line of r.stdout.toString("utf8").split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] !== "missing" && parts[1] !== "ambiguous") present.add(parts[0]!);
  }
  return present;
}
