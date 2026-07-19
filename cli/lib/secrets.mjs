import { readFileSync } from "fs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs, resolveProjectSelector, validateRegularFile } from "./argparse.mjs";
import { editRequestAction } from "./next-actions.mjs";

const HELP = `run402 secrets — Manage project secrets

Usage:
  run402 secrets <subcommand> [args...]

Subcommands:
  set    <key> (--value <v> | --file <path> | --stdin) [--project <id>]
                               Set a secret on a project
  list   [--project <id>]      List all secrets for a project
  delete <key> [--project <id>]  Delete a secret from a project

Legacy (still supported):
  run402 secrets set <prj_id> <key> <value>
  run402 secrets list <prj_id>
  run402 secrets delete <prj_id> <key>

Examples:
  printf %s "$STRIPE_KEY" | run402 secrets set STRIPE_KEY --stdin --project prj_abc123
  run402 secrets set STRIPE_KEY --file ./.secrets/stripe-key --project prj_abc123
  run402 secrets set TLS_CERT --file cert.pem
  run402 secrets list --project prj_abc123
  run402 secrets delete STRIPE_KEY --project prj_abc123

Notes:
  - --project defaults to the active project ('run402 projects use')
  - Secrets are injected as process.env in serverless functions
  - Values are write-only — list returns keys and timestamps only
  - Deploy manifests should declare existing keys with secrets.require; never put values in deploy specs
`;

const SUB_HELP = {
  set: `run402 secrets set — Set a secret on a project

Usage:
  run402 secrets set <key> --value <v> [--project <id>]
  run402 secrets set <key> --file <path> [--project <id>]
  run402 secrets set <key> --stdin [--project <id>]

Legacy (still supported):
  run402 secrets set <prj_id> <key> <value>
  run402 secrets set <key> <value>

Arguments:
  <key>               Secret key name (exposed as process.env.<key>)

Options:
  --project <id>      Project ID (defaults to the active project)
  --value <v>         Inline secret value (alternative to the legacy positional)
  --file <path>       Read the secret value from a file instead of inline
                      Use --file - or --file /dev/stdin to read from stdin
  --stdin             Read the secret value from stdin until EOF

Notes:
  - Provide exactly one value source: --value, --file, --stdin, or the legacy inline positional
  - Secrets are injected as process.env in serverless functions
  - Values are write-only; 'list' cannot verify values by hash
  - Prefer --stdin or --file for real secrets so values do not land in shell history

Examples:
  printf %s "$STRIPE_KEY" | run402 secrets set STRIPE_KEY --stdin --project prj_abc123
  cat ./.secrets/stripe-key | run402 secrets set STRIPE_KEY --file - --project prj_abc123
  run402 secrets set STRIPE_KEY --file ./.secrets/stripe-key
  run402 secrets set TLS_CERT --file cert.pem --project prj_abc123
`,
  list: `run402 secrets list — List all secrets for a project

Usage:
  run402 secrets list [--project <id>]

Legacy (still supported):
  run402 secrets list <prj_id>

Options:
  --project <id>      Project ID (defaults to the active project)

Notes:
  - Returns secret keys and timestamps only; raw values and value-derived hashes are never returned

Examples:
  run402 secrets list --project prj_abc123
`,
  delete: `run402 secrets delete — Delete a secret from a project

Usage:
  run402 secrets delete <key> [--project <id>]

Legacy (still supported):
  run402 secrets delete <prj_id> <key>

Arguments:
  <key>               Secret key name to remove

Options:
  --project <id>      Project ID (defaults to the active project)

Examples:
  run402 secrets delete STRIPE_KEY --project prj_abc123
`,
};

const SET_VALUE_FLAGS = ["--file", "--value", "--project"];

export function readSecretValueForSet(parsedArgs, values, readers = {}) {
  const readStdin = readers.readStdin ?? (() => readFileSync(0, "utf-8"));
  const readFile = readers.readFile ?? ((path) => readFileSync(path, "utf-8"));
  const validateFile = readers.validateFile ?? validateRegularFile;
  const file = flagValue(parsedArgs, "--file");
  const valueFlagPresent = parsedArgs.includes("--value");
  const valueFlag = valueFlagPresent ? flagValue(parsedArgs, "--value") : null;
  const stdinRequested = parsedArgs.includes("--stdin");
  const stdinFile = isStdinAlias(file);
  const sources = [];
  if (values.length === 1) sources.push("inline");
  if (valueFlagPresent) sources.push("--value");
  if (file) sources.push(stdinFile ? "--file stdin" : "--file");
  if (stdinRequested) sources.push("--stdin");

  if (sources.length > 1) {
    fail({
      code: "BAD_USAGE",
      message: "Provide exactly one secret value source.",
      details: { sources },
      hint: "Use one of: --value <v>, --file <path>, --stdin, or an inline value.",
    });
  }
  if (file && !stdinFile) validateFile(file, "--file");

  if (stdinRequested || stdinFile) return readStdin();
  if (valueFlagPresent) return valueFlag;
  if (file) return readFile(file);
  if (values.length === 1) return values[0];
  return undefined;
}

async function set(projectId, args = []) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, [...SET_VALUE_FLAGS, "--stdin", "--help", "-h"], SET_VALUE_FLAGS);
  const positionals = positionalArgs(parsedArgs, SET_VALUE_FLAGS);
  const key = positionals[0];
  if (!key) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <key>.",
      hint: "run402 secrets set <key> --value <v> [--project <id>]",
    });
  }
  const values = positionals.slice(1);
  if (values.length > 1) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for secrets set: ${values[1]}` });
  }
  const val = await readSecretValueForSet(parsedArgs, values, { readStdin: readStdinSecret });
  if (val === undefined) {
    fail({
      code: "BAD_USAGE",
      message: "Missing secret value.",
      hint: "Pipe a value to --stdin, use --file <path>, or provide an inline value only when shell history exposure is acceptable.",
    });
  }
  try {
    await getSdk().secrets.set(projectId, key, { value: val });
    console.log(JSON.stringify({ key, project_id: projectId, set: true }));
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
      editRequestAction("printf %s \"$VALUE\" | run402 secrets set <project> <KEY> --stdin", "Pipe the secret value through stdin."),
      editRequestAction("run402 secrets set <project> <KEY> --file <path>", "Read the secret value from a local file."),
    ],
  });
}

async function list(projectId, args = []) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--project", "--help", "-h"], ["--project"]);
  const extra = positionalArgs(parsedArgs, ["--project"]);
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

async function deleteSecret(projectId, args = []) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--project", "--help", "-h"], ["--project"]);
  const positionals = positionalArgs(parsedArgs, ["--project"]);
  const key = positionals[0];
  if (!key) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <key>.",
      hint: "run402 secrets delete <key> [--project <id>]",
    });
  }
  if (positionals.length > 1) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for secrets delete: ${positionals[1]}` });
  }
  try {
    await getSdk().secrets.delete(projectId, key);
    console.log(JSON.stringify({ key, project_id: projectId, deleted: true }));
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
  if (!["set", "list", "delete"].includes(sub)) {
    fail({ code: "UNKNOWN_SUBCOMMAND", message: `Unknown secrets subcommand: ${sub}`, hint: "Run `run402 secrets --help` for usage.", details: { command: "secrets", subcommand: sub } });
  }
  const parsed = normalizeArgv(Array.isArray(args) ? args : []);
  switch (sub) {
    case "set": {
      const { projectId, rest } = resolveProjectSelector(parsed, { valueFlags: SET_VALUE_FLAGS });
      await set(projectId, rest);
      break;
    }
    case "list": {
      const { projectId, rest } = resolveProjectSelector(parsed, { valueFlags: ["--project"] });
      await list(projectId, rest);
      break;
    }
    case "delete": {
      const { projectId, rest } = resolveProjectSelector(parsed, { valueFlags: ["--project"] });
      await deleteSecret(projectId, rest);
      break;
    }
    default:
      fail({ code: "UNKNOWN_SUBCOMMAND", message: `Unknown secrets subcommand: ${sub}`, hint: "Run `run402 secrets --help` for usage.", details: { command: "secrets", subcommand: sub } });
  }
}
