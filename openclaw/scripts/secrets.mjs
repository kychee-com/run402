#!/usr/bin/env node
/**
 * Run402 secrets manager — set, list, delete project secrets.
 *
 * Usage:
 *   node secrets.mjs set <project_id> <key> <value>
 *   node secrets.mjs list <project_id>
 *   node secrets.mjs delete <project_id> <key>
 */

import { findProject, API } from "./config.mjs";

async function set(projectId, key, value) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/admin/v1/projects/${projectId}/secrets`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify({ status: "ok", message: `Secret '${key}' set for project ${projectId}.` }));
}

async function list(projectId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/admin/v1/projects/${projectId}/secrets`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function deleteSecret(projectId, key) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/admin/v1/projects/${projectId}/secrets/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  if (res.status === 204 || res.ok) {
    console.log(JSON.stringify({ status: "ok", message: `Secret '${key}' deleted.` }));
  } else {
    const data = await res.json().catch(() => ({}));
    console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1);
  }
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "set": await set(args[0], args[1], args[2]); break;
  case "list": await list(args[0]); break;
  case "delete": await deleteSecret(args[0], args[1]); break;
  default:
    console.log("Usage: node secrets.mjs <set|list|delete> [args...]");
    process.exit(1);
}
