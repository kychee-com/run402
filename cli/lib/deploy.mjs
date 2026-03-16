import { readFileSync } from "fs";
import { API, walletAuthHeaders, saveProject } from "./config.mjs";

const HELP = `run402 deploy — Deploy a full-stack app or static site on Run402

Usage:
  run402 deploy [options]
  cat manifest.json | run402 deploy [options]

Options:
  --manifest <file>    Path to manifest JSON file  (default: read from stdin)
  --help, -h           Show this help message

Manifest format (JSON):
  {
    "name": "my-app",
    "migrations": "CREATE TABLE items ...",
    "site": [{ "file": "index.html", "data": "<html>...</html>" }],
    "subdomain": "my-app"
  }

Examples:
  run402 deploy --manifest app.json
  cat app.json | run402 deploy

Prerequisites:
  - run402 init                     Set up wallet and funding
  - run402 tier set prototype       Subscribe to a tier

Notes:
  - Requires an active tier subscription (run402 tier set <tier>)
  - Project credentials (project_id, keys, URL) are saved locally after deploy
  - Use 'run402 projects list' to see all deployed projects
`;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

export async function run(args) {
  const opts = { manifest: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(HELP); process.exit(0); }
    if (args[i] === "--manifest" && args[i + 1]) opts.manifest = args[++i];
  }

  const manifest = opts.manifest ? JSON.parse(readFileSync(opts.manifest, "utf-8")) : JSON.parse(await readStdin());

  const authHeaders = await walletAuthHeaders();
  const res = await fetch(`${API}/deploy/v1`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify(manifest) });
  const result = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...result })); process.exit(1); }
  if (result.project_id) {
    saveProject(result.project_id, {
      anon_key: result.anon_key, service_key: result.service_key,
      tier: result.tier, lease_expires_at: result.lease_expires_at,
      site_url: result.site_url || result.subdomain_url,
      deployed_at: new Date().toISOString(),
    });
  }
  console.log(JSON.stringify(result, null, 2));
}
