import { readFileSync, existsSync } from "fs";
import { findProject, readWallet, API, WALLET_FILE } from "./config.mjs";

const HELP = `run402 functions — Manage serverless functions

Usage:
  run402 functions <subcommand> [args...]

Subcommands:
  deploy <id> <name> --code <file> [--timeout <s>] [--memory <mb>] [--deps <pkg,...>]
                                       Deploy a function to a project
  invoke <id> <name> [--method <M>] [--body <json>]
                                       Invoke a deployed function
  logs   <id> <name> [--tail <n>]      Get function logs
  list   <id>                          List all functions for a project
  delete <id> <name>                   Delete a function

Examples:
  run402 functions deploy abc123 stripe-webhook --code handler.ts
  run402 functions invoke abc123 stripe-webhook --body '{"event":"test"}'
  run402 functions logs abc123 stripe-webhook --tail 100
  run402 functions list abc123
  run402 functions delete abc123 stripe-webhook

Notes:
  - Code must export a default async function: export default async (req: Request) => Response
  - Deploy may require payment if the project lease has expired
`;

async function setupPaidFetch() {
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
  return wrapFetchWithPayment(fetch, client);
}

async function deploy(projectId, name, args) {
  const p = findProject(projectId);
  const opts = { code: null, timeout: undefined, memory: undefined, deps: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--code" && args[i + 1]) opts.code = args[++i];
    if (args[i] === "--timeout" && args[i + 1]) opts.timeout = parseInt(args[++i]);
    if (args[i] === "--memory" && args[i + 1]) opts.memory = parseInt(args[++i]);
    if (args[i] === "--deps" && args[i + 1]) opts.deps = args[++i].split(",");
  }
  if (!opts.code) { console.error(JSON.stringify({ status: "error", message: "Missing --code <file>" })); process.exit(1); }
  const code = readFileSync(opts.code, "utf-8");
  const body = { name, code };
  if (opts.timeout || opts.memory) body.config = {};
  if (opts.timeout) body.config.timeout = opts.timeout;
  if (opts.memory) body.config.memory = opts.memory;
  if (opts.deps) body.deps = opts.deps;

  const fetchPaid = await setupPaidFetch();
  const res = await fetchPaid(`${API}/projects/v1/admin/${projectId}/functions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function invoke(projectId, name, args) {
  const p = findProject(projectId);
  const opts = { method: "POST", body: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--method" && args[i + 1]) opts.method = args[++i];
    if (args[i] === "--body" && args[i + 1]) opts.body = args[++i];
  }
  const fetchOpts = {
    method: opts.method,
    headers: { "apikey": p.service_key },
  };
  if (opts.body && opts.method !== "GET" && opts.method !== "HEAD") {
    fetchOpts.headers["Content-Type"] = "application/json";
    fetchOpts.body = opts.body;
  }
  const res = await fetch(`${API}/functions/v1/${name}`, fetchOpts);
  const text = await res.text();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, body: text })); process.exit(1); }
  try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { process.stdout.write(text + "\n"); }
}

async function logs(projectId, name, args) {
  const p = findProject(projectId);
  let tail = 50;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tail" && args[i + 1]) tail = parseInt(args[++i]);
  }
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/functions/${encodeURIComponent(name)}/logs?tail=${tail}`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function list(projectId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/functions`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function deleteFunction(projectId, name) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/functions/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  if (res.status === 204 || res.ok) {
    console.log(JSON.stringify({ status: "ok", message: `Function '${name}' deleted.` }));
  } else {
    const data = await res.json().catch(() => ({}));
    console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  switch (sub) {
    case "deploy": await deploy(args[0], args[1], args.slice(2)); break;
    case "invoke": await invoke(args[0], args[1], args.slice(2)); break;
    case "logs":   await logs(args[0], args[1], args.slice(2)); break;
    case "list":   await list(args[0]); break;
    case "delete": await deleteFunction(args[0], args[1]); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
