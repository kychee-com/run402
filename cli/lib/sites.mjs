import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileSetFromDir } from "#sdk/node";
import { allowanceAuthHeaders, resolveProjectId, updateProject } from "./config.mjs";
import { resolveFilePathsInManifest } from "./manifest.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";

const SMALL_DIR_THRESHOLD = 5;

const HELP = `run402 sites - Deploy and manage static sites

Usage:
  run402 sites deploy --manifest <file> [--project <id>] [--target <target>]
  run402 sites deploy-dir <path> --project <id> [--target <target>]
  cat manifest.json | run402 sites deploy

Subcommands:
  deploy      Deploy a static site from a manifest JSON
  deploy-dir  Deploy a static site from a local directory (SDK walks it for you)

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
  --dry-run             Plan-only: print the diff envelope and exit
  --confirm-prune       Required when <path> has fewer files than the
                        small-dir guardrail threshold

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
  cat site.json | run402 sites deploy

Notes:
  - Both deploy and deploy-dir route through the unified deploy primitive
    (CAS-backed): only bytes the gateway doesn't already have are uploaded.
    Re-deploys of an unchanged tree make no S3 PUTs.
  - To check status of an in-flight deploy, use 'run402 deploy events <op>'
    or 'run402 deploy list --project <id>'.
  - deploy-dir walks the directory, skips .git / node_modules / .DS_Store,
    and auto-detects binary files. Symlinks are rejected.
  - Progress events are emitted as JSON-line objects on stderr by default
    (one object per line). Final result envelope goes to stdout. Pass --quiet
    to silence stderr.
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
                                  [--dry-run] [--confirm-prune]

Arguments:
  <path>              Local directory to deploy (positional, required)

Options:
  --project <id>      Project ID (defaults to the active project)
  --target <target>   Deployment target (e.g. 'production')
  --quiet             Suppress progress events on stderr (events are on by
                      default — see Progress events below)
  --dry-run           Plan the deploy and print a JSON envelope describing
                      what would happen, then exit. Does NOT upload bytes
                      or commit a release.
  --confirm-prune     Acknowledge that deploying <path> may remove files
                      that exist in the current site but are absent from
                      <path>. Required when <path> contains fewer than
                      ${SMALL_DIR_THRESHOLD} files (the small-dir guardrail).

Behavior:
  - Walks <path> recursively, skips .git / node_modules / .DS_Store
  - Computes per-file SHA-256 and uploads only bytes the gateway doesn't
    already have (CAS-backed unified deploy primitive)
  - A static-site deploy REPLACES the live release: any path in the current
    site that is absent from <path> is removed from the new release. To
    avoid accidentally wiping a multi-page site by deploying a single-file
    directory, a small <path> (fewer than ${SMALL_DIR_THRESHOLD} files) requires
    --confirm-prune.
  - Symlinks are rejected (no following)
  - Paths in the manifest are POSIX-style relative to <path>

Progress events:
  By default, the CLI streams JSON-line events to stderr while the deploy
  progresses. Each line is one JSON object terminated by \\n. Both the
  unified DeployEvent shapes and legacy phase events ({"phase":...}) are
  emitted for back-compat. Stdout receives only the final result envelope.
  To consume both streams separately:
    \`run402 sites deploy-dir ./dist --project p > result.json 2> events.log\`

Notes:
  - Re-deploying an unchanged tree makes no S3 PUTs (returns immediately
    with bytes_uploaded: 0)
  - Free with active tier - requires allowance auth

Examples:
  run402 sites deploy-dir ./dist --project prj_abc
  run402 sites deploy-dir ./my-site --project prj_abc --target production
  run402 sites deploy-dir ./dist --project prj_abc --quiet
  run402 sites deploy-dir ./tiny-site --project prj_abc --confirm-prune
  run402 sites deploy-dir ./dist --project prj_abc --dry-run
`,
};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

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
        message: "--inherit is removed; the SDK now uploads only changed files automatically.",
      }));
      process.exit(1);
    }
  }
  const projectId = resolveProjectId(opts.project);
  const raw = opts.manifest ? readFileSync(opts.manifest, "utf-8") : await readStdin();
  const manifest = JSON.parse(raw);
  if (opts.manifest) resolveFilePathsInManifest(manifest, dirname(resolve(opts.manifest)));

  // Preserve the aggressive early exit when no allowance is configured.
  allowanceAuthHeaders("/deploy/v2/plans");

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
  const opts = {
    dir: null,
    project: undefined,
    target: undefined,
    quiet: false,
    dryRun: false,
    confirmPrune: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(SUB_HELP["deploy-dir"]); process.exit(0); }
    if (args[i] === "--project" && args[i + 1]) { opts.project = args[++i]; continue; }
    if (args[i] === "--target" && args[i + 1]) { opts.target = args[++i]; continue; }
    if (args[i] === "--quiet") { opts.quiet = true; continue; }
    if (args[i] === "--dry-run") { opts.dryRun = true; continue; }
    if (args[i] === "--confirm-prune") { opts.confirmPrune = true; continue; }
    if (args[i] === "--inherit") {
      fail({
        code: "BAD_USAGE",
        message: "--inherit is removed; the SDK now uploads only changed files automatically.",
      });
    }
    if (!args[i].startsWith("-") && opts.dir === null) { opts.dir = args[i]; continue; }
  }
  if (!opts.dir) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <path>.",
      hint: "run402 sites deploy-dir <path> --project <id>",
    });
  }
  const projectId = resolveProjectId(opts.project);

  // Preserve the aggressive early exit when no allowance is configured.
  allowanceAuthHeaders("/deploy/v2/plans");

  let fileSet;
  try {
    fileSet = await fileSetFromDir(opts.dir);
  } catch (err) {
    reportSdkError(err);
    return;
  }
  const fileCount = Object.keys(fileSet).length;

  if (
    fileCount < SMALL_DIR_THRESHOLD &&
    !opts.confirmPrune &&
    !opts.dryRun
  ) {
    console.error(JSON.stringify({
      status: "error",
      code: "PRUNE_CONFIRMATION_REQUIRED",
      message:
        `sites deploy-dir would replace the entire site with ${fileCount} ` +
        `file(s) from ${opts.dir}. Any files in the current release that ` +
        `are absent from this directory will be removed. Pass ` +
        `--confirm-prune to proceed, or --dry-run to preview the diff.`,
      details: {
        local_file_count: fileCount,
        threshold: SMALL_DIR_THRESHOLD,
        dir: opts.dir,
      },
    }));
    process.exit(1);
  }

  if (opts.dryRun) {
    try {
      const { plan } = await getSdk().deploy.plan({
        project: projectId,
        site: { replace: fileSet },
      }, { dryRun: true });
      console.log(JSON.stringify({
        status: "ok",
        dry_run: true,
        local_file_count: fileCount,
        plan_id: plan.plan_id,
        operation_id: plan.operation_id,
        manifest_digest: plan.manifest_digest,
        diff: plan.diff,
        warnings: plan.warnings,
        expected_events: plan.expected_events ?? [],
        missing_content_count: plan.missing_content.filter((p) => !p.present).length,
      }, null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

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

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) { console.log(SUB_HELP[sub] || HELP); process.exit(0); }
  switch (sub) {
    case "deploy":      await deploy(args); break;
    case "deploy-dir":  await deployDir(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
