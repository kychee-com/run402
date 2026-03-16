import { readFileSync } from "fs";
import { API, allowanceAuthHeaders } from "./config.mjs";

const HELP = `run402 sites — Deploy and manage static sites

Usage:
  run402 sites deploy --name <name> --manifest <file> [--project <id>] [--target <target>]
  run402 sites status <deployment_id>
  cat manifest.json | run402 sites deploy --name <name>

Subcommands:
  deploy  Deploy a static site
  status  Check the status of a deployment

Options (deploy):
  --name <name>         Site name (e.g. 'portfolio', 'family-todo')
  --manifest <file>     Path to manifest JSON file (or read from stdin)
  --project <id>        Optional project ID to link this deployment to
  --target <target>     Deployment target (e.g. 'production')
  --help, -h            Show this help message

Manifest format (JSON):
  {
    "files": [
      { "file": "index.html", "data": "<html>...</html>" },
      { "file": "style.css", "data": "body { margin: 0; }" }
    ]
  }

Examples:
  run402 sites deploy --name my-site --manifest site.json
  run402 sites status dep_abc123
  cat site.json | run402 sites deploy --name my-site

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
  const opts = { name: null, manifest: null, project: undefined, target: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(HELP); process.exit(0); }
    if (args[i] === "--name" && args[i + 1]) opts.name = args[++i];
    if (args[i] === "--manifest" && args[i + 1]) opts.manifest = args[++i];
    if (args[i] === "--project" && args[i + 1]) opts.project = args[++i];
    if (args[i] === "--target" && args[i + 1]) opts.target = args[++i];
  }
  if (!opts.name) { console.error(JSON.stringify({ status: "error", message: "Missing --name <name>" })); process.exit(1); }
  const manifest = opts.manifest ? JSON.parse(readFileSync(opts.manifest, "utf-8")) : JSON.parse(await readStdin());
  const body = { name: opts.name, files: manifest.files };
  if (opts.project) body.project = opts.project;
  if (opts.target) body.target = opts.target;

  const authHeaders = await allowanceAuthHeaders();
  const res = await fetch(`${API}/deployments/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
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
