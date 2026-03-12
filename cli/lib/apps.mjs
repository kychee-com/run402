import { existsSync } from "fs";
import { findProject, readWallet, loadProjects, saveProjects, API, WALLET_FILE, PROJECTS_FILE } from "./config.mjs";
import { mkdirSync, writeFileSync } from "fs";

const HELP = `run402 apps — Browse and manage the app marketplace

Usage:
  run402 apps <subcommand> [args...]

Subcommands:
  browse  [--tag <tag>]                   Browse public apps
  fork    <version_id> <name> [--tier <tier>] [--subdomain <name>]
                                           Fork a published app into your own project
  publish <id> [--description <desc>] [--tags <t1,t2>] [--visibility <v>] [--fork-allowed]
                                           Publish a project as an app
  versions <id>                            List published versions of a project

Examples:
  run402 apps browse
  run402 apps browse --tag auth
  run402 apps fork ver_abc123 my-todo --tier prototype
  run402 apps publish proj123 --description "Todo app" --tags todo,auth --visibility public --fork-allowed
  run402 apps versions proj123
`;

async function browse(args) {
  let url = `${API}/v1/apps`;
  const tags = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tag" && args[i + 1]) tags.push(args[++i]);
  }
  if (tags.length > 0) url += "?" + tags.map(t => `tag=${encodeURIComponent(t)}`).join("&");
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function fork(versionId, name, args) {
  const opts = { tier: "prototype", subdomain: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tier" && args[i + 1]) opts.tier = args[++i];
    if (args[i] === "--subdomain" && args[i + 1]) opts.subdomain = args[++i];
  }
  if (!existsSync(WALLET_FILE)) {
    console.error(JSON.stringify({ status: "error", message: "No wallet found. Run: run402 wallet create && run402 wallet fund" }));
    process.exit(1);
  }

  const wallet = readWallet();
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

  const body = { version_id: versionId, name };
  if (opts.subdomain) body.subdomain = opts.subdomain;

  const res = await fetchPaid(`${API}/v1/fork/${opts.tier}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }

  // Save project credentials locally
  if (data.project_id) {
    const projects = loadProjects();
    projects.push({
      project_id: data.project_id, anon_key: data.anon_key, service_key: data.service_key,
      tier: data.tier, lease_expires_at: data.lease_expires_at,
      site_url: data.site_url || data.subdomain_url, deployed_at: new Date().toISOString(),
    });
    const dir = PROJECTS_FILE.replace(/\/[^/]+$/, "");
    mkdirSync(dir, { recursive: true });
    writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify(data, null, 2));
}

async function publish(projectId, args) {
  const p = findProject(projectId);
  const opts = { description: undefined, tags: undefined, visibility: undefined, forkAllowed: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--description" && args[i + 1]) opts.description = args[++i];
    if (args[i] === "--tags" && args[i + 1]) opts.tags = args[++i].split(",");
    if (args[i] === "--visibility" && args[i + 1]) opts.visibility = args[++i];
    if (args[i] === "--fork-allowed") opts.forkAllowed = true;
  }
  const body = {};
  if (opts.description) body.description = opts.description;
  if (opts.tags) body.tags = opts.tags;
  if (opts.visibility) body.visibility = opts.visibility;
  if (opts.forkAllowed !== undefined) body.fork_allowed = opts.forkAllowed;

  const res = await fetch(`${API}/admin/v1/projects/${projectId}/publish`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function versions(projectId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/admin/v1/projects/${projectId}/versions`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  switch (sub) {
    case "browse":   await browse(args); break;
    case "fork":     await fork(args[0], args[1], args.slice(2)); break;
    case "publish":  await publish(args[0], args.slice(1)); break;
    case "versions": await versions(args[0]); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
