import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { readWallet, loadProjects, API, WALLET_FILE, PROJECTS_FILE } from "./config.mjs";

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

function saveProject(project) {
  const projects = loadProjects();
  projects.push({ project_id: project.project_id, anon_key: project.anon_key, service_key: project.service_key, tier: project.tier, lease_expires_at: project.lease_expires_at, site_url: project.site_url || project.subdomain_url, deployed_at: new Date().toISOString() });
  const dir = PROJECTS_FILE.replace(/\/[^/]+$/, "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), { mode: 0o600 });
}

export async function run(args) {
  const opts = { manifest: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(HELP); process.exit(0); }
    if (args[i] === "--manifest" && args[i + 1]) opts.manifest = args[++i];
  }

  if (!existsSync(WALLET_FILE)) {
    console.error(JSON.stringify({ status: "error", message: "No wallet found. Run: run402 wallet create && run402 wallet fund" }));
    process.exit(1);
  }
  const wallet = readWallet();
  const manifest = opts.manifest ? JSON.parse(readFileSync(opts.manifest, "utf-8")) : JSON.parse(await readStdin());

  const { privateKeyToAccount } = await import("viem/accounts");
  const { createPublicClient, http } = await import("viem");
  const { baseSepolia } = await import("viem/chains");
  const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const { toClientEvmSigner } = await import("@x402/evm");

  const account = privateKeyToAccount(wallet.privateKey);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client();
  client.register("eip155:84532", new ExactEvmScheme(signer));
  const fetchPaid = wrapFetchWithPayment(fetch, client);

  const res = await fetchPaid(`${API}/deploy/v1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(manifest) });
  const result = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...result })); process.exit(1); }
  saveProject(result);
  console.log(JSON.stringify(result, null, 2));
}
