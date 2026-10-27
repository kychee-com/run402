/**
 * run402 app-repos — plain git repositories owned by a project and written by
 * its app. A deployed function reads and commits through `repo` / `repos`
 * from @run402/functions; this command lists, creates, deletes, reads and
 * clones them. An app repo is unencrypted and is NOT a KyGit vault (that is
 * `run402 repos`).
 *
 * JSON to stdout (pipe contract); thin shim over `r.appRepos.*`. `clone` runs
 * `git clone` with a URL-scoped credential helper (`run402 app-repos
 * credential`, git's credential-helper protocol) that hands git the project's
 * locally stored service key, so no secret lands in the remote URL or the
 * clone's `.git/config`.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { apiBase, activeProfile, findProject, getProject, resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs, parseIntegerFlag, failUnknownSubcommand } from "./argparse.mjs";
import { isExecutableOnPath } from "./path-lookup.mjs";

const DEFAULT_REPO = "default";
const CLI_ENTRY = fileURLToPath(new URL("../cli.mjs", import.meta.url));

const HELP = `run402 app-repos — plain git repositories your app owns (not a KyGit vault)

Usage:
  run402 app-repos list [--project <project_id>]
  run402 app-repos create <name> [--from <name>] [--project <project_id>]
  run402 app-repos delete <name> --confirm <name> [--project <project_id>]
  run402 app-repos log [<name>] [--path <path>] [--cursor <cursor>] [--limit <n>] [--project <project_id>]
  run402 app-repos cat [<name>] <path> [--at <commit>] [--project <project_id>]
  run402 app-repos ls [<name>] [<dir>] [--at <commit>] [--project <project_id>]
  run402 app-repos clone [<name>] [<dir>] [--project <project_id>]

<name> defaults to "default", the repo every project has without creating it.
--repo <name> may replace the leading <name> wherever it is optional; --path
<path> replaces the <dir> of ls, and --dir <dir> the <dir> of clone.

Options:
  --project <project_id>  Project (defaults to the active project)
  --from <name>           create: start from another repo of the project (shares
                          its history and objects; no bytes are copied)
  --confirm <name>        delete: the repo name again (default cannot be deleted)
  --path <path>           log: only commits that changed this path
  --cursor <cursor>       log: next_cursor from the previous page
  --limit <n>             log: 1-100 commits (default 50)
  --at <commit>           cat / ls: read at this commit instead of the head

Prints:
  list    { app_repos: [{ repo_name, head, seq, commit_count, size_bytes, size,
            clone_url, created_at, updated_at }] }
  log     { commits: [{ commit, parent, seq, author, committer, message,
            committed_at, paths, paths_total, actor_user_id }], head, has_more,
            next_cursor }, newest first
  cat     { repo_name, path, commit, oid, content_type, size_bytes, text } for
          UTF-8, or base64 in place of text for other bytes; a missing file is
          APP_REPO_PATH_NOT_FOUND (exit 1)
  ls      { commit, path, entries: [{ name, path, type: "file" | "dir", size, oid }] }
  clone   { project_id, repo_name, dir, clone_url, credential_helper }

clone runs git clone with a credential helper (run402 app-repos credential) that
gives git the project's service key from this machine's keystore, or
RUN402_GRANT_KEY when it is set; the key is never written into the remote URL
or .git/config, and the helper is kept in the clone so git pull and git push
keep working. main is the only branch and only fast-forward pushes land: undo a
commit with a revert. Each file is at most 4 MiB: put media in assets and
commit a reference to it.

Auth: the project's service_key, your wallet, a sign-in session, or a grant
key. Reads need project.app_repos.read (viewer); create, delete and push need
project.app_repos.write (developer, or a grant with deploy).

Examples:
  run402 app-repos list
  run402 app-repos create user-42 --from template
  run402 app-repos log --path people/p-x.json
  run402 app-repos cat site.json
  run402 app-repos ls default people
  run402 app-repos clone default ./content
`;

export async function run(sub, args) {
  const rest = Array.isArray(args) ? args : [];
  // git's credential-helper protocol: git passes only the operation, so it is
  // dispatched before the --help check (nothing a person types).
  if (sub === "credential") return credential(rest);
  if (sub === undefined || sub === null || sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  switch (sub) {
    case "list": return list(rest);
    case "create": return create(rest);
    case "delete": return remove(rest);
    case "log": return log(rest);
    case "cat": return cat(rest);
    case "ls": return ls(rest);
    case "clone": return clone(rest);
    case "credential": return credential(rest);
    default:
      failUnknownSubcommand("app-repos", sub);
  }
}

/** Parse flags, refuse unknown ones, and return the normalized argv with its positionals. */
function parse(args, valueFlags, boolFlags = []) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...valueFlags, ...boolFlags, "--help", "-h"], valueFlags);
  return { a, pos: positionalArgs(a, valueFlags) };
}

function tooMany(command, extra) {
  fail({
    code: "BAD_USAGE",
    message: `Unexpected argument for app-repos ${command}: ${extra}`,
    hint: "Run `run402 app-repos --help` for usage.",
  });
}

/** The repo name from a leading positional or --repo, never both. */
function repoNameFrom(a, positional, command) {
  const flag = flagValue(a, "--repo");
  if (flag && positional && flag !== positional) {
    fail({
      code: "BAD_USAGE",
      message: `app-repos ${command}: --repo ${flag} disagrees with the positional repo name ${positional}`,
      hint: "Name the repo once.",
    });
  }
  return flag || positional || DEFAULT_REPO;
}

async function call(fn) {
  try {
    const result = await fn(getSdk().appRepos);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const { a, pos } = parse(args, ["--project"]);
  if (pos.length > 0) tooMany("list", pos[0]);
  const projectId = resolveProjectId(flagValue(a, "--project"));
  await call((ar) => ar.list(projectId));
}

async function create(args) {
  const { a, pos } = parse(args, ["--project", "--from"]);
  if (pos.length === 0) {
    fail({ code: "BAD_USAGE", message: "Missing <name>.", hint: "run402 app-repos create <name> [--from <name>]" });
  }
  if (pos.length > 1) tooMany("create", pos[1]);
  const projectId = resolveProjectId(flagValue(a, "--project"));
  const from = flagValue(a, "--from");
  await call((ar) => ar.create(projectId, { repo_name: pos[0], ...(from ? { from } : {}) }));
}

async function remove(args) {
  const { a, pos } = parse(args, ["--project", "--confirm"]);
  if (pos.length === 0) {
    fail({ code: "BAD_USAGE", message: "Missing <name>.", hint: "run402 app-repos delete <name> --confirm <name>" });
  }
  if (pos.length > 1) tooMany("delete", pos[1]);
  const name = pos[0];
  const confirm = flagValue(a, "--confirm");
  if (confirm !== name) {
    fail({
      code: "CONFIRMATION_REQUIRED",
      message: `Deleting app repo ${name} needs --confirm ${name}.`,
      hint: "Its history is gone once no other repo of the project shares its objects.",
      details: { repo_name: name },
      next_actions: [{ type: "run_command", command: `run402 app-repos delete ${name} --confirm ${name}`, why: "confirm the delete by naming the repo again" }],
    });
  }
  const projectId = resolveProjectId(flagValue(a, "--project"));
  await call((ar) => ar.delete(projectId, name, { confirm }));
}

async function log(args) {
  const { a, pos } = parse(args, ["--project", "--repo", "--path", "--cursor", "--limit"]);
  if (pos.length > 1) tooMany("log", pos[1]);
  const repoName = repoNameFrom(a, pos[0], "log");
  const projectId = resolveProjectId(flagValue(a, "--project"));
  const path = flagValue(a, "--path");
  const cursor = flagValue(a, "--cursor");
  const rawLimit = flagValue(a, "--limit");
  const limit = rawLimit === null || rawLimit === undefined ? undefined : parseIntegerFlag("--limit", rawLimit, { min: 1, max: 100 });
  await call((ar) => ar.log(projectId, repoName, {
    ...(path ? { path } : {}),
    ...(cursor ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  }));
}

async function cat(args) {
  const { a, pos } = parse(args, ["--project", "--repo", "--at"]);
  if (pos.length === 0) {
    fail({ code: "BAD_USAGE", message: "Missing <path>.", hint: "run402 app-repos cat [<name>] <path> [--at <commit>]" });
  }
  if (pos.length > 2) tooMany("cat", pos[2]);
  const [namePos, path] = pos.length === 2 ? pos : [undefined, pos[0]];
  const repoName = repoNameFrom(a, namePos, "cat");
  const projectId = resolveProjectId(flagValue(a, "--project"));
  const at = flagValue(a, "--at");
  let file;
  try {
    file = await getSdk().appRepos.readFile(projectId, repoName, path, at ? { at } : {});
  } catch (err) {
    reportSdkError(err);
    return;
  }
  if (!file) {
    fail({
      code: "APP_REPO_PATH_NOT_FOUND",
      message: `No file at ${path} in app repo ${repoName}${at ? ` at ${at}` : ""}.`,
      details: { repo_name: repoName, path, ...(at ? { at } : {}) },
      next_actions: [{ type: "run_command", command: `run402 app-repos ls ${repoName}`, why: "list what the repo holds" }],
    });
  }
  const { bytes, text, ...rest } = file;
  const out = text === null
    ? { ...rest, encoding: "base64", base64: Buffer.from(bytes).toString("base64") }
    : { ...rest, text };
  console.log(JSON.stringify(out, null, 2));
}

async function ls(args) {
  const { a, pos } = parse(args, ["--project", "--repo", "--path", "--at"]);
  if (pos.length > 2) tooMany("ls", pos[2]);
  const repoName = repoNameFrom(a, pos[0], "ls");
  const dirFlag = flagValue(a, "--path");
  if (dirFlag && pos[1] && dirFlag !== pos[1]) {
    fail({ code: "BAD_USAGE", message: `app-repos ls: --path ${dirFlag} disagrees with the positional directory ${pos[1]}`, hint: "Name the directory once." });
  }
  const dir = dirFlag || pos[1];
  const projectId = resolveProjectId(flagValue(a, "--project"));
  const at = flagValue(a, "--at");
  await call((ar) => ar.tree(projectId, repoName, dir || undefined, at ? { at } : {}));
}

/** The git URL of one app repo on the configured API base. */
export function appRepoGitUrl(base, projectId, repoName) {
  return `${base.replace(/\/+$/, "")}/projects/v1/${encodeURIComponent(projectId)}/app-repos/${encodeURIComponent(repoName)}.git`;
}

/** The `!…` credential-helper command persisted in the clone. */
function helperCommand() {
  const parts = [];
  if (process.env.RUN402_API_BASE) parts.push(`RUN402_API_BASE=${shellQuote(process.env.RUN402_API_BASE)}`);
  if (process.env.RUN402_CONFIG_DIR) parts.push(`RUN402_CONFIG_DIR=${shellQuote(process.env.RUN402_CONFIG_DIR)}`);
  parts.push(isExecutableOnPath("run402") ? "run402" : `${shellQuote(process.execPath)} ${shellQuote(CLI_ENTRY)}`);
  const profile = activeProfile();
  if (profile && profile !== "default") parts.push("--wallet", shellQuote(profile));
  parts.push("app-repos", "credential");
  return `!${parts.join(" ")}`;
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function clone(args) {
  const { a, pos } = parse(args, ["--project", "--repo", "--dir"]);
  if (pos.length > 2) tooMany("clone", pos[2]);
  const repoName = repoNameFrom(a, pos[0], "clone");
  const dirFlag = flagValue(a, "--dir");
  if (dirFlag && pos[1] && dirFlag !== pos[1]) {
    fail({ code: "BAD_USAGE", message: `app-repos clone: --dir ${dirFlag} disagrees with the positional directory ${pos[1]}`, hint: "Name the directory once." });
  }
  const dir = resolvePath(dirFlag || pos[1] || repoName);
  const projectId = resolveProjectId(flagValue(a, "--project"));

  // The helper needs a key on this machine: a grant key in the environment,
  // or the project's service key in the keystore (findProject fails with the
  // import next action when it is missing).
  if (!grantKeyFromEnv()) findProject(projectId);

  if (existsSync(dir)) {
    fail({
      code: "BAD_USAGE",
      message: `Destination ${dir} already exists.`,
      hint: "Clone into a new directory: run402 app-repos clone [<name>] <dir>.",
      details: { dir },
    });
  }
  const git = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (git.error || git.status !== 0) {
    fail({
      code: "GIT_NOT_FOUND",
      message: "app-repos clone needs git on PATH.",
      hint: "Install git, then run the clone again.",
    });
  }

  // Resolve the repo first, so a missing repo is APP_REPO_NOT_FOUND with its
  // create next action rather than a bare git 404.
  try {
    await getSdk().appRepos.get(projectId, repoName);
  } catch (err) {
    reportSdkError(err);
    return;
  }

  const url = appRepoGitUrl(apiBase(), projectId, repoName);
  const helper = helperCommand();
  // URL-scoped: the empty value clears any helper a global config would ask
  // (so no keychain ever stores the key), then ours answers; useHttpPath
  // hands it the path so it can name the project. `git clone --config`
  // applies these before the first fetch and keeps them in the clone.
  const scope = `credential.${url}`;
  const result = spawnSync("git", [
    "clone",
    "--config", `${scope}.helper=`,
    "--config", `${scope}.helper=${helper}`,
    "--config", `${scope}.useHttpPath=true`,
    url,
    dir,
  ], { stdio: ["ignore", 2, 2], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (result.error || result.status !== 0) {
    fail({
      code: "GIT_CLONE_FAILED",
      message: `git clone of app repo ${repoName} failed${result.status !== null ? ` (exit ${result.status})` : ""}.`,
      hint: "git's own message is above on stderr.",
      details: { project_id: projectId, repo_name: repoName, clone_url: url, dir },
    });
  }
  const out = { project_id: projectId, repo_name: repoName, dir, clone_url: url, credential_helper: "run402 app-repos credential" };
  if (!isExecutableOnPath("run402")) {
    out.next_actions = [{
      type: "install_cli",
      command: "npm i -g run402",
      why: "the clone's credential helper runs this CLI by its current path; install run402 globally so git pull and git push keep finding it",
    }];
  }
  console.log(JSON.stringify(out, null, 2));
}

function grantKeyFromEnv() {
  const v = process.env.RUN402_GRANT_KEY;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse git's credential-helper input: `key=value` lines up to a blank line. */
export function parseCredentialInput(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (line === "") break;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

const APP_REPO_PATH = /^\/?projects\/v1\/([^/]+)\/app-repos\/([^/]+?)\.git(?:\/.*)?$/;

/**
 * The project an app-repos credential request is for, or null when the
 * request is not for an app repo on the configured API base.
 */
export function credentialTarget(input, base) {
  let api;
  try {
    api = new URL(base);
  } catch {
    return null;
  }
  if (input.protocol && `${input.protocol}:` !== api.protocol) return null;
  if (input.host && input.host.toLowerCase() !== api.host.toLowerCase()) return null;
  if (!input.path) return null;
  let path = input.path;
  const basePath = api.pathname.replace(/^\/+|\/+$/g, "");
  if (basePath) {
    if (!path.replace(/^\/+/, "").startsWith(`${basePath}/`)) return null;
    path = path.replace(/^\/+/, "").slice(basePath.length + 1);
  }
  const m = APP_REPO_PATH.exec(path);
  if (!m) return null;
  try {
    return { projectId: decodeURIComponent(m[1]), repoName: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

/**
 * `run402 app-repos credential <get|store|erase>` — git's credential-helper
 * protocol (gitcredentials(7)). Not for people: `clone` installs it. On `get`
 * for an app repo on the configured API base it prints `username` and
 * `password` (RUN402_GRANT_KEY when set, else the project's service key from
 * the local keystore) and nothing else; it prints nothing for any other URL.
 * `store` and `erase` are no-ops. The key is written only to git, on stdout.
 */
async function credential(args) {
  const op = args[0];
  const input = parseCredentialInput(await readStdin());
  if (op === "store" || op === "erase") return;
  if (op !== "get") {
    fail({
      code: "BAD_USAGE",
      message: "app-repos credential is git's credential helper: get, store or erase, with git's key=value lines on stdin.",
      hint: "run402 app-repos clone installs it; you do not run it yourself.",
    });
  }
  const target = credentialTarget(input, apiBase());
  if (!target) return;
  const password = grantKeyFromEnv() ?? getProject(target.projectId)?.service_key ?? null;
  if (!password) {
    process.stderr.write(
      `run402: no key for project ${target.projectId} on this machine; import one with \`run402 credentials project-keys import --project ${target.projectId} --service-key-stdin\`, or set RUN402_GRANT_KEY.\n`,
    );
    return;
  }
  process.stdout.write(`username=run402\npassword=${password}\n`);
}
