import { findProject, API } from "./config.mjs";

const HELP = `run402 secrets — Manage project secrets

Usage:
  run402 secrets <subcommand> [args...]

Subcommands:
  set    <id> <key> <value>    Set a secret on a project
  list   <id>                  List all secrets for a project
  delete <id> <key>            Delete a secret from a project

Examples:
  run402 secrets set abc123 STRIPE_KEY sk-1234
  run402 secrets list abc123
  run402 secrets delete abc123 STRIPE_KEY

Notes:
  - Secrets are injected as process.env in serverless functions
  - Values are never shown after being set
`;

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

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  switch (sub) {
    case "set":    await set(args[0], args[1], args[2]); break;
    case "list":   await list(args[0]); break;
    case "delete": await deleteSecret(args[0], args[1]); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
