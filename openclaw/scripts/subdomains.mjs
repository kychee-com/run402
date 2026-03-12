#!/usr/bin/env node
/**
 * Run402 subdomains manager — claim, list, delete subdomains.
 *
 * Usage:
 *   node subdomains.mjs claim <deployment_id> <name> [--project <id>]
 *   node subdomains.mjs list <project_id>
 *   node subdomains.mjs delete <name> [--project <id>]
 */

import { findProject, API } from "./config.mjs";

async function claim(deploymentId, name, extraArgs) {
  const opts = { project: null };
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] === "--project" && extraArgs[i + 1]) opts.project = extraArgs[++i];
  }
  const headers = { "Content-Type": "application/json" };
  if (opts.project) {
    const p = findProject(opts.project);
    headers["Authorization"] = `Bearer ${p.service_key}`;
  }
  const res = await fetch(`${API}/v1/subdomains`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, deployment_id: deploymentId }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function deleteSubdomain(name, extraArgs) {
  const opts = { project: null };
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] === "--project" && extraArgs[i + 1]) opts.project = extraArgs[++i];
  }
  const headers = {};
  if (opts.project) {
    const p = findProject(opts.project);
    headers["Authorization"] = `Bearer ${p.service_key}`;
  }
  const res = await fetch(`${API}/v1/subdomains/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers,
  });
  if (res.status === 204 || res.ok) {
    console.log(JSON.stringify({ status: "ok", message: `Subdomain '${name}' released.` }));
  } else {
    const data = await res.json().catch(() => ({}));
    console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1);
  }
}

async function list(projectId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/v1/subdomains`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "claim": await claim(args[0], args[1], args.slice(2)); break;
  case "list": await list(args[0]); break;
  case "delete": await deleteSubdomain(args[0], args.slice(1)); break;
  default:
    console.log("Usage: node subdomains.mjs <claim|list|delete> [args...]");
    process.exit(1);
}
