import { readFileSync } from "fs";
import { findProject, API } from "./config.mjs";

const HELP = `run402 secrets — Manage project secrets

Usage:
  run402 secrets <subcommand> [args...]

Subcommands:
  set    <id> <key> <value> [--file <path>]  Set a secret on a project
  list   <id>                  List all secrets for a project
  delete <id> <key>            Delete a secret from a project

Examples:
  run402 secrets set abc123 STRIPE_KEY sk-1234
  run402 secrets set abc123 TLS_CERT --file cert.pem
  run402 secrets list abc123
  run402 secrets delete abc123 STRIPE_KEY

Notes:
  - Secrets are injected as process.env in serverless functions
  - Values are write-only — list returns keys with a value_hash (first 8 hex chars of SHA-256) for verifying the correct value was set
`;

const SUB_HELP = {
  set: `run402 secrets set — Set a secret on a project

Usage:
  run402 secrets set <id> <key> <value> [--file <path>]
  run402 secrets set <id> <key> --file <path>

Arguments:
  <id>                Project ID (from 'run402 projects list')
  <key>               Secret key name (exposed as process.env.<key>)
  <value>             Inline secret value (omit if using --file)

Options:
  --file <path>       Read the secret value from a file instead of inline

Notes:
  - Secrets are injected as process.env in serverless functions
  - Values are write-only; 'list' returns a value_hash for verification

Examples:
  run402 secrets set abc123 STRIPE_KEY sk-1234
  run402 secrets set abc123 TLS_CERT --file cert.pem
`,
};

async function set(projectId, key, args = []) {
  const p = findProject(projectId);
  let file = null;
  let value = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) { file = args[++i]; }
    else if (!value && !args[i].startsWith("--")) { value = args[i]; }
  }
  const val = file ? readFileSync(file, "utf-8") : value;
  if (!val) { console.error(JSON.stringify({ status: "error", message: "Missing secret value. Provide inline or use --file <path>" })); process.exit(1); }
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/secrets`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ key, value: val }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify({ status: "ok", message: `Secret '${key}' set for project ${projectId}.` }));
}

async function list(projectId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/secrets`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function deleteSecret(projectId, key) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/secrets/${encodeURIComponent(key)}`, {
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
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(SUB_HELP[sub] || HELP);
    process.exit(0);
  }
  switch (sub) {
    case "set":    await set(args[0], args[1], args.slice(2)); break;
    case "list":   await list(args[0]); break;
    case "delete": await deleteSecret(args[0], args[1]); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
