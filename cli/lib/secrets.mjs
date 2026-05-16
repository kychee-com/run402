import { readFileSync } from "fs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs, validateRegularFile } from "./argparse.mjs";

const HELP = `run402 secrets — Manage project secrets

Usage:
  run402 secrets <subcommand> [args...]

Subcommands:
  set    <id> <key> <value> [--file <path>|--stdin]  Set a secret on a project
  list   <id>                  List all secrets for a project
  delete <id> <key>            Delete a secret from a project

Examples:
  printf %s "$STRIPE_KEY" | run402 secrets set prj_abc123 STRIPE_KEY --stdin
  run402 secrets set prj_abc123 STRIPE_KEY --file ./.secrets/stripe-key
  run402 secrets set prj_abc123 TLS_CERT --file cert.pem
  run402 secrets list prj_abc123
  run402 secrets delete prj_abc123 STRIPE_KEY

Notes:
  - Secrets are injected as process.env in serverless functions
  - Values are write-only — list returns keys and timestamps only
  - Deploy manifests should declare existing keys with secrets.require; never put values in deploy specs
`;

const SUB_HELP = {
  set: `run402 secrets set — Set a secret on a project

Usage:
  run402 secrets set <id> <key> <value>
  run402 secrets set <id> <key> --file <path>
  run402 secrets set <id> <key> --stdin

Arguments:
  <id>                Project ID (from 'run402 projects list')
  <key>               Secret key name (exposed as process.env.<key>)
  <value>             Inline secret value (omit if using --file or --stdin)

Options:
  --file <path>       Read the secret value from a file instead of inline
                      Use --file - or --file /dev/stdin to read from stdin
  --stdin             Read the secret value from stdin until EOF

Notes:
  - Secrets are injected as process.env in serverless functions
  - Values are write-only; 'list' cannot verify values by hash
  - Prefer --stdin or --file for real secrets so values do not land in shell history

Examples:
  printf %s "$STRIPE_KEY" | run402 secrets set prj_abc123 STRIPE_KEY --stdin
  cat ./.secrets/stripe-key | run402 secrets set prj_abc123 STRIPE_KEY --file -
  run402 secrets set prj_abc123 STRIPE_KEY --file ./.secrets/stripe-key
  run402 secrets set prj_abc123 TLS_CERT --file cert.pem
`,
  list: `run402 secrets list — List all secrets for a project

Usage:
  run402 secrets list <id>

Arguments:
  <id>                Project ID (from 'run402 projects list')

Notes:
  - Returns secret keys and timestamps only; raw values and value-derived hashes are never returned

Examples:
  run402 secrets list prj_abc123
`,
  delete: `run402 secrets delete — Delete a secret from a project

Usage:
  run402 secrets delete <id> <key>

Arguments:
  <id>                Project ID (from 'run402 projects list')
  <key>               Secret key name to remove

Examples:
  run402 secrets delete prj_abc123 STRIPE_KEY
`,
};

async function set(projectId, key, args = []) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--file"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--stdin", "--help", "-h"], valueFlags);
  const values = positionalArgs(parsedArgs, valueFlags);
  if (values.length > 1) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for secrets set: ${values[1]}` });
  }
  const file = flagValue(parsedArgs, "--file");
  const useStdinFlag = parsedArgs.includes("--stdin");
  const fileIsStdin = isStdinAlias(file);
  const sources = [];
  if (values.length === 1) sources.push("inline");
  if (file) sources.push(fileIsStdin ? "--file stdin" : "--file");
  if (useStdinFlag) sources.push("--stdin");
  if (sources.length > 1) {
    fail({
      code: "BAD_USAGE",
      message: "Provide exactly one secret value source.",
      details: { sources },
      hint: "Use one of: inline value, --file <path>, or --stdin.",
    });
  }
  if (file && !fileIsStdin) validateRegularFile(file, "--file");
  const val = useStdinFlag || fileIsStdin
    ? await readStdinSecret()
    : file
      ? readFileSync(file, "utf-8")
      : values.length === 1
        ? values[0]
        : undefined;
  if (val === undefined) {
    fail({
      code: "BAD_USAGE",
      message: "Missing secret value.",
      hint: "Pipe a value to --stdin, use --file <path>, or provide an inline value only when shell history exposure is acceptable.",
    });
  }
  try {
    await getSdk().secrets.set(projectId, key, val);
    console.log(JSON.stringify({ status: "ok", message: `Secret '${key}' set for project ${projectId}.` }));
  } catch (err) {
    reportSdkError(err);
  }
}

function isStdinAlias(file) {
  return file === "-" || file === "/dev/stdin";
}

async function readStdinSecret() {
  if (process.stdin?.isTTY) {
    failMissingStdin();
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  if (chunks.length === 0) {
    failMissingStdin();
  }
  const value = Buffer.concat(chunks).toString("utf-8");
  if (value.length === 0) {
    failMissingStdin();
  }
  return value;
}

function failMissingStdin() {
  fail({
    code: "BAD_USAGE",
    message: "Missing secret value on stdin.",
    hint: "Pipe a value, use --file <path>, or provide an inline value only when shell history exposure is acceptable.",
    next_actions: [
      "printf %s \"$VALUE\" | run402 secrets set <project> <KEY> --stdin",
      "run402 secrets set <project> <KEY> --file <path>",
    ],
  });
}

async function list(projectId, args = []) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const extra = positionalArgs(parsedArgs);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for secrets list: ${extra[0]}` });
  }
  try {
    const data = await getSdk().secrets.list(projectId);
    const sanitized = {
      secrets: (data.secrets || []).map((s) => ({
        key: s.key,
        ...(s.created_at ? { created_at: s.created_at } : {}),
        ...(s.updated_at ? { updated_at: s.updated_at } : {}),
      })),
    };
    console.log(JSON.stringify(sanitized, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteSecret(projectId, key, args = []) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const extra = positionalArgs(parsedArgs);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for secrets delete: ${extra[0]}` });
  }
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
    case "list":   await list(args[0], args.slice(1)); break;
    case "delete": await deleteSecret(args[0], args[1], args.slice(2)); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
