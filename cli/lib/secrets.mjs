import { readFileSync } from "fs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";

const HELP = `run402 secrets — Manage project secrets

Usage:
  run402 secrets <subcommand> [args...]

Subcommands:
  set    <id> <key> <value> [--file <path>]  Set a secret on a project
  list   <id>                  List all secrets for a project
  delete <id> <key>            Delete a secret from a project

Examples:
  run402 secrets set prj_abc123 STRIPE_KEY sk-1234
  run402 secrets set prj_abc123 TLS_CERT --file cert.pem
  run402 secrets list prj_abc123
  run402 secrets delete prj_abc123 STRIPE_KEY

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
  run402 secrets set prj_abc123 STRIPE_KEY sk-1234
  run402 secrets set prj_abc123 TLS_CERT --file cert.pem
`,
};

async function set(projectId, key, args = []) {
  let file = null;
  let value = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) { file = args[++i]; }
    else if (!value && !args[i].startsWith("--")) { value = args[i]; }
  }
  const val = file ? readFileSync(file, "utf-8") : value;
  if (!val) {
    fail({
      code: "BAD_USAGE",
      message: "Missing secret value.",
      hint: "Provide inline or use --file <path>",
    });
  }
  try {
    await getSdk().secrets.set(projectId, key, val);
    console.log(JSON.stringify({ status: "ok", message: `Secret '${key}' set for project ${projectId}.` }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(projectId) {
  try {
    const data = await getSdk().secrets.list(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteSecret(projectId, key) {
  try {
    await getSdk().secrets.delete(projectId, key);
    console.log(JSON.stringify({ status: "ok", message: `Secret '${key}' deleted.` }));
  } catch (err) {
    reportSdkError(err);
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
