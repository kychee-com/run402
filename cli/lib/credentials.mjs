import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  activeProfile,
  getProject,
  loadKeyStore,
  projectCredentialsFile,
  removeProject,
  saveProject,
} from "./config.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs } from "./argparse.mjs";
import { fail } from "./sdk-errors.mjs";

const HELP = `run402 credentials — Manage local credential material

Usage:
  run402 credentials <subcommand> [args...]

Subcommands:
  project-keys  Manage the local project-key cache

Examples:
  run402 credentials project-keys list
  run402 credentials project-keys status --project prj_abc123
  run402 credentials project-keys import --project prj_abc123 --service-key-stdin
  run402 credentials project-keys export --project prj_abc123 --reveal
`;

const PROJECT_KEYS_HELP = `run402 credentials project-keys — Manage local project-key cache entries

Usage:
  run402 credentials project-keys <subcommand> [options]

Subcommands:
  list                                List cached project-key entries, redacted
  status --project <id>               Show one cached entry, redacted
  import --project <id> --service-key-stdin
  import --project <id> --service-key-env <env>
  export --project <id> --reveal       Print cached keys, including secrets
  remove --project <id>                Remove one cached key entry

Notes:
  - This is a LOCAL CACHE surface. It is not project inventory.
  - list/status never reveal full keys.
  - export requires --reveal.
  - import accepts service keys through stdin or an environment variable, not argv.
`;

function parseProjectKeyFlags(args, extraKnown = [], valueFlagsExtra = []) {
  const parsed = normalizeArgv(args);
  const valueFlags = ["--project", ...valueFlagsExtra];
  assertKnownFlags(parsed, ["--project", "--help", "-h", ...extraKnown], valueFlags);
  return {
    projectId: flagValue(parsed, "--project"),
    parsed,
    rest: positionalArgs(parsed, valueFlags),
  };
}

function fingerprint(value) {
  if (!value) return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function prefix(value) {
  if (!value) return null;
  return `${value.slice(0, 8)}...`;
}

function provenance() {
  const profile = activeProfile();
  return {
    source: "local_cache",
    cache_path: projectCredentialsFile(),
    wallet: profile,
    profile,
  };
}

function redactedEntry(projectId, entry) {
  return {
    project_id: projectId,
    configured: Boolean(entry),
    has_anon_key: Boolean(entry?.anon_key),
    has_service_key: Boolean(entry?.service_key),
    anon_key_prefix: prefix(entry?.anon_key),
    service_key_prefix: prefix(entry?.service_key),
    anon_key_fingerprint: fingerprint(entry?.anon_key),
    service_key_fingerprint: fingerprint(entry?.service_key),
    site_url: entry?.site_url ?? null,
    cached_at: entry?.cached_at ?? null,
    ...provenance(),
  };
}

function requireProjectFlag(projectId, usage) {
  if (!projectId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing --project <id>.",
      hint: usage,
    });
  }
  return projectId;
}

function requireCachedProject(projectId) {
  const entry = getProject(projectId);
  if (!entry) {
    fail({
      code: "PROJECT_CREDENTIAL_NOT_FOUND",
      message: `No local project credentials cached for ${projectId}.`,
      hint: "Import keys with `run402 credentials project-keys import --project <id> --service-key-stdin` if this operation truly requires local project credentials.",
      details: { project_id: projectId, ...provenance() },
      next_actions: [{
        type: "run_command",
        command: `run402 credentials project-keys import --project ${projectId} --service-key-stdin`,
        why: "Import a service key for credential-required operations.",
      }],
    });
  }
  return entry;
}

async function list(args) {
  const { rest } = parseProjectKeyFlags(args);
  if (rest.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for project-keys list: ${rest[0]}` });
  }
  const store = loadKeyStore(projectCredentialsFile());
  const projects = Object.entries(store.projects ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([projectId, entry]) => redactedEntry(projectId, entry));
  console.log(JSON.stringify({ projects, ...provenance() }, null, 2));
}

async function status(args) {
  const { projectId, rest } = parseProjectKeyFlags(args);
  if (rest.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for project-keys status: ${rest[0]}` });
  }
  const id = requireProjectFlag(projectId, "run402 credentials project-keys status --project <id>");
  console.log(JSON.stringify(redactedEntry(id, getProject(id)), null, 2));
}

function readSecretInput(parsed) {
  const fromEnv = flagValue(parsed, "--service-key-env");
  const fromStdin = parsed.includes("--service-key-stdin");
  if (fromEnv && fromStdin) {
    fail({ code: "BAD_USAGE", message: "Use either --service-key-env or --service-key-stdin, not both." });
  }
  if (fromEnv) {
    const value = process.env[fromEnv];
    if (!value) {
      fail({
        code: "BAD_ENV",
        message: `Environment variable ${fromEnv} is empty or unset.`,
        details: { env: fromEnv },
      });
    }
    return value.trim();
  }
  if (fromStdin) return readFileSync(0, "utf-8").trim();
  fail({
    code: "BAD_USAGE",
    message: "Import requires --service-key-stdin or --service-key-env <env>.",
    hint: "Do not pass service keys as command-line values; argv can leak through shell history and process listings.",
  });
}

async function importKey(args) {
  const { projectId, parsed, rest } = parseProjectKeyFlags(
    args,
    ["--service-key-stdin", "--service-key-env", "--anon-key-env"],
    ["--service-key-env", "--anon-key-env"],
  );
  if (rest.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for project-keys import: ${rest[0]}` });
  }
  const id = requireProjectFlag(projectId, "run402 credentials project-keys import --project <id> --service-key-stdin");
  const serviceKey = readSecretInput(parsed);
  if (!serviceKey) {
    fail({ code: "BAD_USAGE", message: "Service key input was empty." });
  }
  const anonEnv = flagValue(parsed, "--anon-key-env");
  const anonKey = anonEnv ? process.env[anonEnv] : undefined;
  if (anonEnv && !anonKey) {
    fail({ code: "BAD_ENV", message: `Environment variable ${anonEnv} is empty or unset.`, details: { env: anonEnv } });
  }
  const existing = getProject(id);
  saveProject(id, {
    anon_key: anonKey ?? existing?.anon_key ?? "",
    service_key: serviceKey,
    site_url: existing?.site_url,
    deployed_at: existing?.deployed_at,
    last_deployment_id: existing?.last_deployment_id,
    source: "manual_import",
    cached_at: new Date().toISOString(),
  });
  console.log(JSON.stringify({ imported: true, ...redactedEntry(id, getProject(id)) }, null, 2));
}

async function exportKey(args) {
  const { projectId, parsed, rest } = parseProjectKeyFlags(args, ["--reveal"]);
  if (rest.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for project-keys export: ${rest[0]}` });
  }
  const id = requireProjectFlag(projectId, "run402 credentials project-keys export --project <id> --reveal");
  if (!parsed.includes("--reveal")) {
    fail({
      code: "REVEAL_REQUIRED",
      message: "Exporting full project keys requires --reveal.",
      hint: "Use `run402 credentials project-keys status --project <id>` for redacted output.",
      details: { project_id: id, ...provenance() },
    });
  }
  const entry = requireCachedProject(id);
  console.log(JSON.stringify({ project_id: id, ...entry, ...provenance(), revealed: true }, null, 2));
}

async function remove(args) {
  const { projectId, rest } = parseProjectKeyFlags(args);
  if (rest.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for project-keys remove: ${rest[0]}` });
  }
  const id = requireProjectFlag(projectId, "run402 credentials project-keys remove --project <id>");
  const existed = Boolean(getProject(id));
  removeProject(id, projectCredentialsFile());
  console.log(JSON.stringify({ project_id: id, removed: existed, ...provenance() }, null, 2));
}

async function runProjectKeys(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(PROJECT_KEYS_HELP);
    process.exit(0);
  }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(PROJECT_KEYS_HELP);
    process.exit(0);
  }
  switch (sub) {
    case "list": await list(args); break;
    case "status": await status(args); break;
    case "import": await importKey(args); break;
    case "export": await exportKey(args); break;
    case "remove": await remove(args); break;
    default:
      fail({
        code: "UNKNOWN_SUBCOMMAND",
        message: `Unknown credentials project-keys subcommand: ${sub}`,
        hint: "Run `run402 credentials project-keys --help` for usage.",
        details: { command: "credentials project-keys", subcommand: sub },
      });
  }
}

export async function run(sub, args = []) {
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    process.exit(0);
  }
  if (sub === "project-keys") {
    const [projectKeySub, ...rest] = Array.isArray(args) ? args : [];
    await runProjectKeys(projectKeySub, rest);
    return;
  }
  fail({
    code: "UNKNOWN_SUBCOMMAND",
    message: `Unknown credentials subcommand: ${sub}`,
    hint: "Run `run402 credentials --help` for usage.",
    details: { command: "credentials", subcommand: sub },
  });
}
