import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { allowanceAuthHeaders, resolveProjectId, updateProject } from "./config.mjs";
import { resolveFilePathsInManifest } from "./manifest.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";

const HELP = `run402 sites — Deploy and manage static sites

Usage:
  run402 sites deploy --manifest <file> [--project <id>] [--target <target>]
  run402 sites deploy-dir <path> --project <id> [--target <target>] [--inherit]
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
  --inherit             Copy unchanged files from the previous deployment (only upload changed files)
  --help, -h            Show this help message

Options (deploy-dir):
  <path>                Positional: local directory to deploy
  --project <id>        Project ID (defaults to active project)
  --target <target>     Deployment target (e.g. 'production')
  --inherit             Copy unchanged files from the previous deployment server-side

Manifest format (JSON):
  {
    "files": [
      { "file": "index.html", "data": "<html>...</html>" },
      { "file": "style.css", "path": "./dist/style.css" }
    ]
  }

  Files can use either inline "data" or a local "path":
    { "file": "index.html", "data": "<html>...</html>" }   ← inline content
    { "file": "style.css",  "path": "./dist/style.css" }   ← read from disk
  Paths are resolved relative to the manifest file's directory.
  Binary files (images, fonts, etc.) are auto-detected and base64-encoded.

Examples:
  run402 sites deploy --manifest site.json
  run402 sites deploy-dir ./my-site --project prj_abc --inherit
  run402 sites status dpl_abc123
  cat site.json | run402 sites deploy

Notes:
  - deploy-dir walks the directory, skips .git / node_modules / .DS_Store,
    and auto-detects binary files. Symlinks are rejected.
  - Free with active tier — requires allowance auth
`;

const SUB_HELP = {
  deploy: `run402 sites deploy — Deploy a static site from a manifest

Usage:
  run402 sites deploy --manifest <file> [--project <id>] [--target <target>] [--inherit]
  cat manifest.json | run402 sites deploy [--project <id>] [--target <target>]

Options:
  --manifest <file>   Path to manifest JSON file (or read from stdin)
  --project <id>      Project ID (defaults to the active project)
  --target <target>   Deployment target (e.g. 'production')
  --inherit           Copy unchanged files from the previous deployment
                      (only upload changed files)

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
  - Free with active tier — requires allowance auth

Examples:
  run402 sites deploy --manifest site.json
  run402 sites deploy --manifest site.json --target production --inherit
  cat site.json | run402 sites deploy
`,
  "deploy-dir": `run402 sites deploy-dir — Deploy a static site from a local directory

Usage:
  run402 sites deploy-dir <path> [--project <id>] [--target <target>] [--inherit]

Arguments:
  <path>              Local directory to deploy (positional, required)

Options:
  --project <id>      Project ID (defaults to the active project)
  --target <target>   Deployment target (e.g. 'production')
  --inherit           Copy unchanged files from the previous deployment

Behavior:
  - Walks <path> recursively, skips .git / node_modules / .DS_Store
  - UTF-8 files are inlined as text; binary files are base64-encoded
  - Symlinks are rejected (no following)
  - Paths in the manifest are POSIX-style relative to <path>

Notes:
  - Practical size limit today is ~100 MB (inline JSON payload).
    For larger sites, use a pre-built manifest with the bundle_deploy API
    or wait for blob-backed deploys.
  - Free with active tier — requires allowance auth

Examples:
  run402 sites deploy-dir ./dist --project prj_abc
  run402 sites deploy-dir ./my-site --project prj_abc --target production --inherit
`,
};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function deploy(args) {
  const opts = { manifest: null, project: undefined, target: undefined, inherit: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(HELP); process.exit(0); }
    if (args[i] === "--manifest" && args[i + 1]) opts.manifest = args[++i];
    if (args[i] === "--project" && args[i + 1]) opts.project = args[++i];
    if (args[i] === "--target" && args[i + 1]) opts.target = args[++i];
    if (args[i] === "--inherit") opts.inherit = true;
  }
  const projectId = resolveProjectId(opts.project);
  const raw = opts.manifest ? readFileSync(opts.manifest, "utf-8") : await readStdin();
  const manifest = JSON.parse(raw);
  if (opts.manifest) resolveFilePathsInManifest(manifest, dirname(resolve(opts.manifest)));

  // Preserve the aggressive early exit when no allowance is configured.
  allowanceAuthHeaders("/deployments/v1");

  try {
    const data = await getSdk().sites.deploy(projectId, {
      files: manifest.files,
      target: opts.target,
      inherit: opts.inherit,
    });
    if (data.deployment_id) {
      updateProject(projectId, { last_deployment_id: data.deployment_id });
    }
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deployDir(args) {
  const opts = { dir: null, project: undefined, target: undefined, inherit: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(SUB_HELP["deploy-dir"]); process.exit(0); }
    if (args[i] === "--project" && args[i + 1]) { opts.project = args[++i]; continue; }
    if (args[i] === "--target" && args[i + 1]) { opts.target = args[++i]; continue; }
    if (args[i] === "--inherit") { opts.inherit = true; continue; }
    if (!args[i].startsWith("-") && opts.dir === null) { opts.dir = args[i]; continue; }
  }
  if (!opts.dir) {
    console.error(JSON.stringify({ status: "error", message: "Missing <path>. Usage: run402 sites deploy-dir <path> --project <id>" }));
    process.exit(1);
  }
  const projectId = resolveProjectId(opts.project);

  // Preserve the aggressive early exit when no allowance is configured.
  allowanceAuthHeaders("/deployments/v1");

  try {
    const data = await getSdk().sites.deployDir({
      project: projectId,
      dir: opts.dir,
      target: opts.target,
      inherit: opts.inherit,
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
