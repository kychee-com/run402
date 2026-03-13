#!/usr/bin/env node
/**
 * Run402 functions manager — deploy, invoke, logs, list, delete serverless functions.
 *
 * Usage:
 *   node functions.mjs deploy <project_id> <name> --code <file> [--timeout <s>] [--memory <mb>] [--deps <pkg,...>]
 *   node functions.mjs invoke <project_id> <name> [--method <M>] [--body <json>]
 *   node functions.mjs logs <project_id> <name> [--tail <n>]
 *   node functions.mjs list <project_id>
 *   node functions.mjs delete <project_id> <name>
 */

import { readFileSync, existsSync } from "fs";
import { findProject, readWallet, API, WALLET_FILE } from "./config.mjs";

async function setupPaidFetch() {
  if (!existsSync(WALLET_FILE)) {
    console.error(JSON.stringify({ status: "error", message: "No wallet found. Run: node wallet.mjs create && node wallet.mjs fund" }));
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

async function deploy(projectId, name, extraArgs) {
  const p = findProject(projectId);
  const opts = { code: null, timeout: undefined, memory: undefined, deps: undefined };
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] === "--code" && extraArgs[i + 1]) opts.code = extraArgs[++i];
    if (extraArgs[i] === "--timeout" && extraArgs[i + 1]) opts.timeout = parseInt(extraArgs[++i]);
    if (extraArgs[i] === "--memory" && extraArgs[i + 1]) opts.memory = parseInt(extraArgs[++i]);
    if (extraArgs[i] === "--deps" && extraArgs[i + 1]) opts.deps = extraArgs[++i].split(",");
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

async function invoke(projectId, name, extraArgs) {
  const p = findProject(projectId);
  const opts = { method: "POST", body: undefined };
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] === "--method" && extraArgs[i + 1]) opts.method = extraArgs[++i];
    if (extraArgs[i] === "--body" && extraArgs[i + 1]) opts.body = extraArgs[++i];
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

async function logs(projectId, name, extraArgs) {
  const p = findProject(projectId);
  let tail = 50;
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] === "--tail" && extraArgs[i + 1]) tail = parseInt(extraArgs[++i]);
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

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "deploy": await deploy(args[0], args[1], args.slice(2)); break;
  case "invoke": await invoke(args[0], args[1], args.slice(2)); break;
  case "logs": await logs(args[0], args[1], args.slice(2)); break;
  case "list": await list(args[0]); break;
  case "delete": await deleteFunction(args[0], args[1]); break;
  default:
    console.log("Usage: node functions.mjs <deploy|invoke|logs|list|delete> [args...]");
    process.exit(1);
}
