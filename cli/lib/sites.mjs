import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { allowanceAuthHeaders, resolveProjectId, updateProject } from "./config.mjs";
import { resolveFilePathsInManifest } from "./manifest.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";

const HELP = `run402 sites - Deploy and manage static sites

Usage:
  run402 sites deploy --manifest <file> [--project <id>] [--target <target>]
  run402 sites deploy-dir <path> --project <id> [--target <target>]
  run402 sites status <deployment_id>
  cat manifest.json | run402 sites deploy

Subcommands:
  deploy      Deploy a static site from a manifest JSON
  deploy-dir  Deploy a static site from a local directory (SDK walks it for you)
  status      Check the status of a deployment

Options (deploy):
  --manifest <file>     Path to manifest JSON file (or read from stdin)
  --project <id>        Project ID (defaults to active project)
  --target <target>     Deployment target (e.g. 'production')
  --help, -h            Show this help message

Options (deploy-dir):
  <path>                Positional: local directory to deploy
  --project <id>        Project ID (defaults to active project)
  --target <target>     Deployment target (e.g. 'production')
  --quiet               Suppress progress events on stderr

Manifest format (JSON):
  {
    "files": [
      { "file": "index.html", "data": "<html>...</html>" },
      { "file": "style.css", "path": "./dist/style.css" }
    ]
  }

  Files can use either inline "data" or a local "path":
    { "file": "index.html", "data": "<html>...</html>" }   <- inline content
    { "file": "style.css",  "path": "./dist/style.css" }   <- read from disk
  Paths are resolved relative to the manifest file's directory.
  Binary files (images, fonts, etc.) are auto-detected and base64-encoded.

Examples:
  run402 sites deploy --manifest site.json
  run402 sites deploy-dir ./my-site --project prj_abc
  run402 sites status dpl_abc123
  cat site.json | run402 sites deploy

Notes:
  - Both deploy and deploy-dir use the v1.32 plan/commit transport: only
    bytes the gateway doesn't already have are uploaded. Re-deploys of an
    unchanged tree make no S3 PUTs.
  - deploy-dir walks the directory, skips .git / node_modules / .DS_Store,
    and auto-detects binary files. Symlinks are rejected.
  - Progress events are emitted as JSON-line objects on stderr by default
    (one object per line: {"phase":"plan",...}/{"phase":"upload",...}/...).
    Final result envelope goes to stdout. Pass --quiet to silence stderr.
  - Free with active tier - requires allowance auth
`;

const SUB_HELP = {
  deploy: `run402 sites deploy - Deploy a static site from a manifest

Usage:
  run402 sites deploy --manifest <file> [--project <id>] [--target <target>]
  cat manifest.json | run402 sites deploy [--project <id>] [--target <target>]

Options:
  --manifest <file>   Path to manifest JSON file (or read from stdin)
  --project <id>      Project ID (defaults to the active project)
  --target <target>   Deployment target (e.g. 'production')

Manifest format (JSON):
  {
    "files": [
      { "file": "index.html", "data": "<html>...</html>" },
      { "file": "style.css", "path": "./dist/style.css" }
    ]
  }
  Paths are resolved relative to the manifest file's directory.
  Binary files are auto-detected and base64-encoded.

Notes:
  - Must include at least index.html in the files array
  - Free with active tier - requires allowance auth

Examples:
  run402 sites deploy --manifest site.json
  run402 sites deploy --manifest site.json --target production
  cat site.json | run402 sites deploy
`,
  "deploy-dir": `run402 sites deploy-dir - Deploy a static site from a local directory

Usage:
  run402 sites deploy-dir <path> [--project <id>] [--target <target>] [--quiet]

Arguments:
  <path>              Local directory to deploy (positional, required)

Options:
  --project <id>      Project ID (defaults to the active project)
  --target <target>   Deployment target (e.g. 'production')
  --quiet             Suppress progress events on stderr (events are on by
                      default — see Progress events below)

Behavior:
  - Walks <path> recursively, skips .git / node_modules / .DS_Store
  - Computes per-file SHA-256 and uploads only bytes the gateway doesn't
    already have (plan/commit transport, v1.32+)
  - Symlinks are rejected (no following)
  - Paths in the manifest are POSIX-style relative to <path>

Progress events:
  By default, the CLI streams JSON-line events to stderr while the deploy
  progresses. Each line is one JSON object terminated by \\n. Phases:
    {"phase":"plan","manifest_size":N}            - after POST /deploy/v1/plan
    {"phase":"upload","file":"...","sha256":"...","done":k,"total":N}
                                                  - per uploaded file (k of N)
    {"phase":"commit"}                            - before POST /deploy/v1/commit
    {"phase":"poll","status":"copying","elapsed_ms":N}
                                                  - per Stage-2 copy poll tick
  Stdout receives only the final result envelope. To consume both streams
  separately: \`run402 sites deploy-dir ./dist --project p > result.json 2> events.log\`.

Notes:
  - Re-deploying an unchanged tree makes no S3 PUTs (returns immediately
    with bytes_uploaded: 0)
  - Free with active tier - requires allowance auth

Examples:
  run402 sites deploy-dir ./dist --project prj_abc
  run402 sites deploy-dir ./my-site --project prj_abc --target production
  run402 sites deploy-dir ./dist --project prj_abc --quiet
`,
};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Stage manifest files to a temp directory so the SDK's deployDir can walk
 * them. The v1.32 SDK no longer accepts inline file bytes — every deploy
 * goes through plan/commit and reads from a directory.
 */
function stageFilesToTempDir(files) {
  const stage = mkdtempSync(join(tmpdir(), "run402-deploy-stage-"));
  for (const f of files) {
    if (typeof f.file !== "string" || typeof f.data !== "string") {
      throw new Error("manifest entry missing required 'file' or 'data' string");
    }
    const target = join(stage, f.file);
    mkdirSync(dirname(target), { recursive: true });
    const buf = (f.encoding ?? "utf-8") === "base64"
      ? Buffer.from(f.data, "base64")
      : Buffer.from(f.data, "utf-8");
    writeFileSync(target, buf);
  }
  return stage;
}

/**
 * Returns an onEvent callback that writes each event as a single-line JSON
 * object to stderr — or a no-op when --quiet was passed. The CLI is
 * agent-first; structured stderr lets a piping agent stream progress with
 * `2>events.log` while keeping stdout reserved for the final result envelope.
 *
 * Uses `console.error` so that test harnesses intercepting console output
 * see each event line; `console.error` appends a newline by default.
 */
function makeStderrEventWriter(quiet) {
  if (quiet) return undefined;
  return (event) => {
    console.error(JSON.stringify(event));
  };
}

async function deploy(args) {
  const opts = { manifest: null, project: undefined, target: undefined, quiet: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(HELP); process.exit(0); }
    if (args[i] === "--manifest" && args[i + 1]) opts.manifest = args[++i];
    if (args[i] === "--project" && args[i + 1]) opts.project = args[++i];
    if (args[i] === "--target" && args[i + 1]) opts.target = args[++i];
    if (args[i] === "--quiet") opts.quiet = true;
    if (args[i] === "--inherit") {
      console.error(JSON.stringify({
        status: "error",
        message: "--inherit is removed in v1.32; the SDK now uploads only changed files automatically.",
      }));
      process.exit(1);
    }
  }
  const projectId = resolveProjectId(opts.project);
  const raw = opts.manifest ? readFileSync(opts.manifest, "utf-8") : await readStdin();
  const manifest = JSON.parse(raw);
  if (opts.manifest) resolveFilePathsInManifest(manifest, dirname(resolve(opts.manifest)));

  // Preserve the aggressive early exit when no allowance is configured.
  allowanceAuthHeaders("/deploy/v1/plan");

  const stage = stageFilesToTempDir(manifest.files || []);
  try {
    const data = await getSdk().sites.deployDir({
      project: projectId,
      dir: stage,
      target: opts.target,
      onEvent: makeStderrEventWriter(opts.quiet),
    });
    if (data.deployment_id) {
      updateProject(projectId, { last_deployment_id: data.deployment_id });
    }
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function deployDir(args) {
  const opts = { dir: null, project: undefined, target: undefined, quiet: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(SUB_HELP["deploy-dir"]); process.exit(0); }
    if (args[i] === "--project" && args[i + 1]) { opts.project = args[++i]; continue; }
    if (args[i] === "--target" && args[i + 1]) { opts.target = args[++i]; continue; }
    if (args[i] === "--quiet") { opts.quiet = true; continue; }
    if (args[i] === "--inherit") {
      console.error(JSON.stringify({
        status: "error",
        message: "--inherit is removed in v1.32; the SDK now uploads only changed files automatically.",
      }));
      process.exit(1);
    }
    if (!args[i].startsWith("-") && opts.dir === null) { opts.dir = args[i]; continue; }
  }
  if (!opts.dir) {
    console.error(JSON.stringify({ status: "error", message: "Missing <path>. Usage: run402 sites deploy-dir <path> --project <id>" }));
    process.exit(1);
  }
  const projectId = resolveProjectId(opts.project);

  // Preserve the aggressive early exit when no allowance is configured.
  allowanceAuthHeaders("/deploy/v1/plan");

  try {
    const data = await getSdk().sites.deployDir({
      project: projectId,
      dir: opts.dir,
      target: opts.target,
      onEvent: makeStderrEventWriter(opts.quiet),
    });
    if (data.deployment_id) {
      updateProject(projectId, { last_deployment_id: data.deployment_id });
    }
    console.log(JSON.stringify({ status: "ok", ...data }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function status(args) {
  let deploymentId = null;
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("-")) { deploymentId = args[i]; break; }
  }
  if (!deploymentId) { console.error(JSON.stringify({ status: "error", message: "Missing deployment ID" })); process.exit(1); }
  try {
    const data = await getSdk().sites.getDeployment(deploymentId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) { console.log(SUB_HELP[sub] || HELP); process.exit(0); }
  switch (sub) {
    case "deploy":      await deploy(args); break;
    case "deploy-dir":  await deployDir(args); break;
    case "status":      await status(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
