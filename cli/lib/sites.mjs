import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { API, allowanceAuthHeaders, resolveProjectId, updateProject } from "./config.mjs";
import { resolveFilePathsInManifest } from "./manifest.mjs";

const HELP = `run402 sites — Deploy and manage static sites

Usage:
  run402 sites deploy --manifest <file> [--project <id>] [--target <target>]
  run402 sites status <deployment_id>
  cat manifest.json | run402 sites deploy

Subcommands:
  deploy  Deploy a static site
  status  Check the status of a deployment

Options (deploy):
  --manifest <file>     Path to manifest JSON file (or read from stdin)
  --project <id>        Project ID (defaults to active project)
  --target <target>     Deployment target (e.g. 'production')
  --help, -h            Show this help message

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
  run402 sites status dpl_abc123
  cat site.json | run402 sites deploy

Notes:
  - Must include at least index.html in the files array
  - Free with active tier — requires allowance auth
`;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function deploy(args) {
  const opts = { manifest: null, project: undefined, target: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(HELP); process.exit(0); }
    if (args[i] === "--manifest" && args[i + 1]) opts.manifest = args[++i];
    if (args[i] === "--project" && args[i + 1]) opts.project = args[++i];
    if (args[i] === "--target" && args[i + 1]) opts.target = args[++i];
  }
  const projectId = resolveProjectId(opts.project);
  const raw = opts.manifest ? readFileSync(opts.manifest, "utf-8") : await readStdin();
  const manifest = JSON.parse(raw);
  if (opts.manifest) resolveFilePathsInManifest(manifest, dirname(resolve(opts.manifest)));
  const body = { files: manifest.files, project: projectId };
  if (opts.target) body.target = opts.target;

  const authHeaders = allowanceAuthHeaders("/deployments/v1");
  const res = await fetch(`${API}/deployments/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  if (data.deployment_id) {
    updateProject(projectId, { last_deployment_id: data.deployment_id });
  }
  console.log(JSON.stringify(data, null, 2));
}

async function status(args) {
  let deploymentId = null;
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("-")) { deploymentId = args[i]; break; }
  }
  if (!deploymentId) { console.error(JSON.stringify({ status: "error", message: "Missing deployment ID" })); process.exit(1); }
  const res = await fetch(`${API}/deployments/v1/${deploymentId}`);
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  switch (sub) {
    case "deploy":  await deploy(args); break;
    case "status":  await status(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
