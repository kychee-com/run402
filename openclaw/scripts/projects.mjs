#!/usr/bin/env node
/**
 * Run402 project manager — list, inspect, query, renew, delete projects.
 *
 * Usage:
 *   node projects.mjs list                          # List saved projects
 *   node projects.mjs sql <project_id> "SELECT 1"   # Run SQL
 *   node projects.mjs rest <project_id> <table> [query_params]  # REST query
 *   node projects.mjs usage <project_id>             # Check usage vs limits
 *   node projects.mjs schema <project_id>            # Inspect tables/columns/RLS
 *   node projects.mjs renew <project_id>             # Renew lease (x402 payment)
 *   node projects.mjs delete <project_id>            # Archive and delete project
 */

import { findProject, loadProjects, saveProjects, readWallet, API, WALLET_FILE, PROJECTS_FILE } from "./config.mjs";
import { existsSync, mkdirSync, writeFileSync } from "fs";

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

async function quote() {
  const res = await fetch(`${API}/v1/projects`);
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function provision(extraArgs) {
  const opts = { tier: "prototype", name: undefined };
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] === "--tier" && extraArgs[i + 1]) opts.tier = extraArgs[++i];
    if (extraArgs[i] === "--name" && extraArgs[i + 1]) opts.name = extraArgs[++i];
  }
  const fetchPaid = await setupPaidFetch();
  const body = { tier: opts.tier };
  if (opts.name) body.name = opts.name;
  const res = await fetchPaid(`${API}/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  if (data.project_id) {
    const projects = loadProjects();
    projects.push({
      project_id: data.project_id, anon_key: data.anon_key, service_key: data.service_key,
      tier: data.tier, lease_expires_at: data.lease_expires_at, deployed_at: new Date().toISOString(),
    });
    const dir = PROJECTS_FILE.replace(/\/[^/]+$/, "");
    mkdirSync(dir, { recursive: true });
    writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify(data, null, 2));
}

async function rls(projectId, template, tablesJson) {
  const p = findProject(projectId);
  const tables = JSON.parse(tablesJson);
  const res = await fetch(`${API}/admin/v1/projects/${projectId}/rls`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ template, tables }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function list() {
  const projects = loadProjects();
  if (projects.length === 0) {
    console.log(JSON.stringify({ status: "ok", projects: [], message: "No projects yet." }));
    return;
  }
  console.log(JSON.stringify(projects.map(p => ({
    project_id: p.project_id,
    tier: p.tier,
    site_url: p.site_url,
    lease_expires_at: p.lease_expires_at,
    deployed_at: p.deployed_at,
  })), null, 2));
}

async function sql(projectId, query) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/admin/v1/projects/${projectId}/sql`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "text/plain" },
    body: query,
  });
  console.log(JSON.stringify(await res.json(), null, 2));
}

async function rest(projectId, table, queryParams) {
  const p = findProject(projectId);
  const url = `${API}/rest/v1/${table}${queryParams ? '?' + queryParams : ''}`;
  const res = await fetch(url, { headers: { "apikey": p.anon_key } });
  console.log(JSON.stringify(await res.json(), null, 2));
}

async function usage(projectId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/admin/v1/projects/${projectId}/usage`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function schema(projectId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/admin/v1/projects/${projectId}/schema`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function renew(projectId) {
  const fetchPaid = await setupPaidFetch();
  const res = await fetchPaid(`${API}/v1/projects/${projectId}/renew`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }

  const projects = loadProjects();
  const idx = projects.findIndex(pr => pr.project_id === projectId);
  if (idx >= 0 && data.lease_expires_at) {
    projects[idx].lease_expires_at = data.lease_expires_at;
    saveProjects(projects);
  }
  console.log(JSON.stringify(data, null, 2));
}

async function deleteProject(projectId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/v1/projects/${projectId}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  if (res.status === 204 || res.ok) {
    saveProjects(loadProjects().filter(pr => pr.project_id !== projectId));
    console.log(JSON.stringify({ status: "ok", message: `Project ${projectId} deleted.` }));
  } else {
    const data = await res.json().catch(() => ({}));
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "quote": await quote(); break;
  case "provision": await provision(args); break;
  case "list": await list(); break;
  case "sql": await sql(args[0], args[1]); break;
  case "rest": await rest(args[0], args[1], args[2]); break;
  case "usage": await usage(args[0]); break;
  case "schema": await schema(args[0]); break;
  case "rls": await rls(args[0], args[1], args[2]); break;
  case "renew": await renew(args[0]); break;
  case "delete": await deleteProject(args[0]); break;
  default:
    console.log("Usage: node projects.mjs <quote|provision|list|sql|rest|usage|schema|rls|renew|delete> [args...]");
    process.exit(1);
}
