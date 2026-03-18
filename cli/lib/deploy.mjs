import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { API, allowanceAuthHeaders, findProject } from "./config.mjs";
import { resolveFilePathsInManifest } from "./manifest.mjs";

const HELP = `run402 deploy — Deploy to an existing project on Run402

Usage:
  run402 deploy [options]
  cat manifest.json | run402 deploy [options]

Options:
  --manifest <file>    Path to manifest JSON file  (default: read from stdin)
  --project <id>       Project ID to deploy to     (default: active project)
  --help, -h           Show this help message

Manifest format (JSON):
  {
    "project_id": "prj_...",
    "migrations": "CREATE TABLE items (id serial PRIMARY KEY, title text NOT NULL, done boolean DEFAULT false)",
    "rls": {
      "template": "public_read_write",
      "tables": [{ "table": "items" }]
    },
    "secrets": [{ "key": "OPENAI_API_KEY", "value": "sk-..." }],
    "functions": [{
      "name": "my-fn",
      "code": "export default async (req) => new Response('ok')"
    }],
    "files": [
      { "file": "index.html", "data": "<html>...</html>" },
      { "file": "style.css", "path": "./dist/style.css" }
    ],
    "subdomain": "my-app"
  }

  project_id is required (provision first with 'run402 provision').
  All other fields are optional.

  Files can use either inline "data" or a local "path":
    { "file": "index.html", "data": "<html>...</html>" }   ← inline content
    { "file": "style.css",  "path": "./dist/style.css" }   ← read from disk
  Paths are resolved relative to the manifest file's directory.
  Binary files (images, fonts, etc.) are auto-detected and base64-encoded.

  RLS templates:
    user_owns_rows   — users see only their rows (requires owner_column per table)
    public_read      — anyone reads, authenticated users write
    public_read_write — anyone reads and writes

  ⚠️  Without RLS, tables are read-only via anon_key. If your app writes
  data from the browser, you almost certainly need an rls block.

Examples:
  run402 deploy --manifest app.json
  run402 deploy --manifest app.json --project prj_123_1
  cat app.json | run402 deploy

Prerequisites:
  - run402 init                     Set up allowance and funding
  - run402 tier set prototype       Subscribe to a tier
  - run402 provision                Provision a project first

Notes:
  - Requires an active tier subscription (run402 tier set <tier>)
  - Provision a project first with 'run402 provision', then deploy to it
  - Use 'run402 projects list' to see all provisioned projects
`;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

export async function run(args) {
  const opts = { manifest: null, project: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(HELP); process.exit(0); }
    if (args[i] === "--manifest" && args[i + 1]) opts.manifest = args[++i];
    if (args[i] === "--project" && args[i + 1]) opts.project = args[++i];
  }

  const raw = opts.manifest ? readFileSync(opts.manifest, "utf-8") : await readStdin();
  const manifest = JSON.parse(raw);
  if (opts.manifest) resolveFilePathsInManifest(manifest, dirname(resolve(opts.manifest)));

  // --project flag overrides manifest's project_id
  if (opts.project) manifest.project_id = opts.project;

  // If no project_id in manifest, use active project
  if (!manifest.project_id) {
    const { id } = findProject(null);
    manifest.project_id = id;
  }

  // Remove legacy 'name' field if present
  delete manifest.name;

  const authHeaders = allowanceAuthHeaders("/deploy/v1");
  const res = await fetch(`${API}/deploy/v1`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify(manifest) });
  const result = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...result })); process.exit(1); }
  console.log(JSON.stringify(result, null, 2));
}
