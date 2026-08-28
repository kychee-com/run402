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
import {
  assertKnownFlags,
  flagValue,
  normalizeArgv,
  positionalArgs,
  failUnknownSubcommand,
  requirePositionalCount,
  resolveProjectSelector,
} from "./argparse.mjs";
import { fail, reportSdkError } from "./sdk-errors.mjs";
import { getSdk } from "./sdk.mjs";

const HELP = `run402 credentials — Project credentials, and the local key cache

Usage:
  run402 credentials <subcommand> [args...]

Project credentials (on the gateway — named, revocable, rotatable):
  issue --kind <anon|service> --name <name> [--project <id>] [--expires <iso8601>] [--import]
                                Mint one. The secret is printed ONCE.
                                --import also writes it into this machine's
                                local key cache (the cold-restart re-key path).
  list [--project <id>] [--include-revoked]
                                List credentials (metadata only, never secrets)
  status [--project <id>]       Are you still on the retiring legacy key?
  rotate <credential_id> [--project <id>]
                                Replace in one step; new secret printed ONCE
  revoke <credential_id> [--project <id>] [--reason <text>]
                                Revoke immediately, freeing the name
  token [--project <id>] [--kind <anon|service>]
                                Mint a SHORT-LIVED token. Works with only a
                                delegate — the unattended recovery path.

Local cache (on this machine):
  project-keys                  Manage the local project-key cache

Notes:
  - 'issue', 'rotate' and 'revoke' need owner membership on the project's org
    plus a fresh step-up, so a scoped agent credential can never escalate
    itself into a permanent root. Authenticate with a wallet (SIWX) or a
    control-plane session ('run402 operator login --step-up').
  - 'token' is the exception: a delegate can mint one with no human present.
  - Secrets are returned EXACTLY ONCE and are never recoverable. Full JSON goes
    to stdout so you can pipe it; the warnings go to stderr.

Examples:
  run402 credentials status --project prj_abc123
  run402 credentials issue --kind service --name ci-deploy --project prj_abc123
  run402 credentials issue --kind service --name ci-deploy | jq -r .secret
  run402 credentials rotate pcr_123 --project prj_abc123
  run402 credentials project-keys list
`;

const PROJECT_KEYS_HELP = `run402 credentials project-keys — Manage local project-key cache entries

Usage:
  run402 credentials project-keys <subcommand> [options]

Subcommands:
  list                                List cached project-key entries, redacted
  status --project <id>               Show one cached entry, redacted
  import --project <id> --service-key-stdin
  import --project <id> --service-key-env <env>
  import --project <id> --anon-key-env <env>   Rotate only the anon key
  export --project <id> --reveal       Print cached keys, including secrets
  remove --project <id>                Remove one cached key entry

Notes:
  - This is a LOCAL CACHE surface. It is not project inventory.
  - list/status never reveal full keys.
  - export requires --reveal.
  - import accepts service keys through stdin or an environment variable, not argv.
  - import writes the whole entry, so the FIRST import must supply a service key.
    Afterwards --anon-key-env alone rotates the anon key and keeps the cached
    service key, so an anon rotation never puts a service key through a shell.
`;

const SUB_HELP = {
  issue: `run402 credentials issue — mint a named project credential

Usage:
  run402 credentials issue --kind <anon|service> --name <name> [--project <id>] [--import]
                           [--expires <iso8601>]

--kind    "anon" is the tenant-facing key; "service" is the privileged one.
--name    Unique among this project's LIVE credentials. Re-using a live name
          returns 409 CREDENTIAL_NAME_TAKEN — that collision is the idempotency
          story, so a retried create never mints a second credential by accident.
--expires Optional; must be in the future and within one year.
--import  Also write the minted secret into this machine's local key cache
          (what deploys and data-plane commands read) — the cold-restart
          re-key path in ONE step instead of issue-then-project-keys-import.
          A first --kind anon --import on a machine with no cached entry
          still needs a service key first, same as project-keys import.

The secret is printed ONCE, on stdout, inside the JSON. Pipe it:
  run402 credentials issue --kind service --name ci | jq -r .secret

Requires owner membership on the project's org plus a fresh step-up. A delegate
can NEVER do this; use 'run402 credentials token' instead.
`,
  list: `run402 credentials list — list a project's credentials

Usage:
  run402 credentials list [--project <id>] [--include-revoked]

Metadata only — never a secret or a secret hash. Only project.read is needed.
`,
  status: `run402 credentials status — are you still on the retiring legacy key?

Usage:
  run402 credentials status [--project <id>]

Returns state "legacy" while the project still depends on the derived
anon/service keys, or "rotatable" once it holds credentials it can revoke
individually.

There is deliberately NO deadline: retirement is gated on conditions (every
tenant migrated, 30 consecutive days of zero legacy-key use, explicit operator
approval), not a date. Read retirement.gated_on rather than planning against a
date the platform has not committed to.
`,
  rotate: `run402 credentials rotate — replace a credential in one step

Usage:
  run402 credentials rotate <credential_id> [--project <id>]

Mints a replacement and revokes the old one in a single transaction, keeping
the name. The NEW secret is printed once.

For a rotation with no downtime window, prefer issuing a SECOND credential,
deploying it, then revoking the first — several may be live per kind at once,
and that overlap is the point. Use 'rotate' when the old secret is already
compromised.
`,
  revoke: `run402 credentials revoke — revoke a credential immediately

Usage:
  run402 credentials revoke <credential_id> [--project <id>] [--reason <text>]

Takes effect for every subsequent request and frees the name for reuse.
Requires owner membership plus step-up.
`,
  token: `run402 credentials token — mint a short-lived project token

Usage:
  run402 credentials token [--project <id>] [--kind <anon|service>]

The cold-restart recovery path, and the ONE credential call an agent can make
with no human present: a delegate is accepted here. There is no step-up because
there is nobody to prompt, and what you get back expires, so it cannot become a
durable root. Defaults to --kind service.
`,
};

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

function readSecretInput(parsed, { projectId, anonEnv, existing } = {}) {
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

  // Anon-only rotation: the caller passed --anon-key-env and the entry already
  // caches a service key. Reuse it rather than making them round-trip a service
  // key through --reveal and a shell just to change the anon key.
  if (anonEnv && existing?.service_key) return existing.service_key;

  // Still no service key. Report the flags the caller actually passed — an error
  // that names only the service-key flags reads as "--anon-key-env is not a flag".
  if (anonEnv) {
    fail({
      code: "BAD_USAGE",
      message: `Importing an anon key also requires a service key, because import writes the whole cache entry and no service key is cached for ${projectId} yet.`,
      hint: "Add --service-key-stdin or --service-key-env <env> to this first import. Once an entry exists, --anon-key-env alone rotates the anon key and keeps the cached service key.",
      details: { project_id: projectId, anon_key_env: anonEnv },
    });
  }

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
  // Resolve --anon-key-env before requiring a service key, so a missing service
  // key can report against the flags actually passed and an anon-only rotation
  // can reuse the cached service key.
  const anonEnv = flagValue(parsed, "--anon-key-env");
  const anonKey = anonEnv ? process.env[anonEnv] : undefined;
  if (anonEnv && !anonKey) {
    fail({ code: "BAD_ENV", message: `Environment variable ${anonEnv} is empty or unset.`, details: { env: anonEnv } });
  }
  const existing = getProject(id);
  const serviceKey = readSecretInput(parsed, { projectId: id, anonEnv, existing });
  if (!serviceKey) {
    fail({ code: "BAD_USAGE", message: "Service key input was empty." });
  }
  saveProject(id, {
    anon_key: anonKey ?? existing?.anon_key ?? "",
    service_key: serviceKey,
    site_url: existing?.site_url,
    deployed_at: existing?.deployed_at,
    last_deployment_id: existing?.last_deployment_id,
    // Carried, not re-derived: a key import says nothing about which org owns
    // the project, and dropping the cache here would make `run402 init` reach
    // for the control plane again on a machine that already knew.
    org_id: existing?.org_id,
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
      failUnknownSubcommand("credentials project-keys", sub);
  }
}

// ---------------------------------------------------------------------------
// Project credentials — the gateway rows, not the local cache.
//
// These five routes shipped with no client at all, so the documented way off
// the legacy derived anon/service keys was to hand-roll a SIWX-signed request.
// `run402 pay` is NOT that escape hatch (it is the x402 buyer path and 401s
// here), which is how an agent could read the docs, find the route, and still
// have no way to call it.
// ---------------------------------------------------------------------------

/** Full JSON on stdout (pipeable); the one-shot warning on stderr. */
function emitIssued(res) {
  console.log(JSON.stringify(res, null, 2));
  if (res?.secret) {
    console.error("");
    console.error("The secret above is shown ONCE and cannot be read back.");
    console.error("Store it now — 'rotate' is the only way to get a new one.");
  }
}

const ISSUE_VALUE_FLAGS = ["--project", "--kind", "--name", "--expires"];

async function issue(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...ISSUE_VALUE_FLAGS, "--import", "--help", "-h"], ISSUE_VALUE_FLAGS);
  const importToCache = a.includes("--import");
  const kind = flagValue(a, "--kind");
  const name = flagValue(a, "--name");
  const expiresAt = flagValue(a, "--expires");
  const { projectId, rest } = resolveProjectSelector(a, { valueFlags: ISSUE_VALUE_FLAGS });
  requirePositionalCount(rest, ISSUE_VALUE_FLAGS, {
    min: 0,
    max: 0,
    command: "run402 credentials issue --kind <anon|service> --name <name> [--project <id>] [--import]",
    missing: "",
  });
  if (kind !== "anon" && kind !== "service") {
    fail({
      message: 'Missing or invalid --kind. Use "anon" (tenant-facing) or "service" (privileged).',
      code: "BAD_USAGE",
      hint: "run402 credentials issue --kind service --name ci-deploy",
    });
  }
  if (!name) {
    fail({
      message: "Missing --name.",
      code: "BAD_USAGE",
      hint: "The name identifies this credential in 'list' and is how you rotate it later, e.g. --name ci-deploy",
    });
  }
  // Validate the --import precondition BEFORE minting: refusing after the
  // mint would burn a show-once secret on a usage error.
  const existing = importToCache ? getProject(projectId) : undefined;
  if (importToCache && kind === "anon" && !existing?.service_key) {
    fail({
      code: "BAD_USAGE",
      message: `--import for an anon key writes the whole cache entry, and no service key is cached for ${projectId} yet.`,
      hint: "Run 'run402 credentials issue --kind service --name <name> --import' first (same rule as project-keys import).",
      details: { project_id: projectId },
    });
  }
  try {
    const res = await getSdk().credentials.issue(projectId, { kind, name, expiresAt: expiresAt || undefined });
    if (importToCache && res?.secret) {
      // The cold-restart re-key path (gitvault-deploy-lane 6.5a): the minted
      // secret goes straight into the local cache the deploy and data-plane
      // commands read, so a fresh machine re-keys in one command per kind
      // instead of the four-command issue-then-project-keys-import dance.
      // The secret never rides argv; it came back on the mint response.
      saveProject(projectId, {
        anon_key: kind === "anon" ? res.secret : existing?.anon_key ?? "",
        service_key: kind === "service" ? res.secret : existing?.service_key ?? "",
        site_url: existing?.site_url,
        deployed_at: existing?.deployed_at,
        last_deployment_id: existing?.last_deployment_id,
        org_id: existing?.org_id,
        source: "credentials_issue_import",
        cached_at: new Date().toISOString(),
      });
      emitIssued({ ...res, imported_to_local_cache: true });
      return;
    }
    emitIssued(res);
  } catch (err) {
    reportSdkError(err);
  }
}

async function listCredentials(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--project", "--include-revoked", "--help", "-h"], ["--project"]);
  const { projectId, rest } = resolveProjectSelector(a, { valueFlags: ["--project"] });
  requirePositionalCount(rest, ["--project"], {
    min: 0,
    max: 0,
    command: "run402 credentials list [--project <id>]",
    missing: "",
  });
  try {
    const includeRevoked = a.includes("--include-revoked");
    console.log(JSON.stringify(await getSdk().credentials.list(projectId, { includeRevoked }), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function credentialStatus(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--project", "--help", "-h"], ["--project"]);
  const { projectId, rest } = resolveProjectSelector(a, { valueFlags: ["--project"] });
  requirePositionalCount(rest, ["--project"], {
    min: 0,
    max: 0,
    command: "run402 credentials status [--project <id>]",
    missing: "",
  });
  try {
    const res = await getSdk().credentials.status(projectId);
    console.log(JSON.stringify(res, null, 2));
    if (res?.state === "legacy") {
      console.error("");
      console.error("This project still depends on the derived anon/service keys, whose signing");
      console.error("key is being retired. Issue a credential to stop depending on them:");
      console.error(`  run402 credentials issue --kind service --name primary --project ${projectId}`);
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function rotate(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--project", "--help", "-h"], ["--project"]);
  const { projectId, rest } = resolveProjectSelector(a, { valueFlags: ["--project"] });
  const [credentialId] = requirePositionalCount(rest, ["--project"], {
    min: 1,
    max: 1,
    command: "run402 credentials rotate <credential_id> [--project <id>]",
    missing: "Missing <credential_id>. Find it with: run402 credentials list",
  });
  try {
    emitIssued(await getSdk().credentials.rotate(projectId, credentialId));
  } catch (err) {
    reportSdkError(err);
  }
}

async function revoke(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--project", "--reason", "--help", "-h"], ["--project", "--reason"]);
  const reason = flagValue(a, "--reason");
  const { projectId, rest } = resolveProjectSelector(a, { valueFlags: ["--project", "--reason"] });
  const [credentialId] = requirePositionalCount(rest, ["--project", "--reason"], {
    min: 1,
    max: 1,
    command: "run402 credentials revoke <credential_id> [--project <id>]",
    missing: "Missing <credential_id>. Find it with: run402 credentials list",
  });
  try {
    const res = await getSdk().credentials.revoke(projectId, credentialId, reason ? { reason } : {});
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function token(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--project", "--kind", "--help", "-h"], ["--project", "--kind"]);
  const kind = flagValue(a, "--kind");
  const { projectId, rest } = resolveProjectSelector(a, { valueFlags: ["--project", "--kind"] });
  requirePositionalCount(rest, ["--project", "--kind"], {
    min: 0,
    max: 0,
    command: "run402 credentials token [--project <id>]",
    missing: "",
  });
  if (kind && kind !== "anon" && kind !== "service") {
    fail({ message: '--kind must be "anon" or "service".', code: "BAD_USAGE" });
  }
  try {
    const res = await getSdk().credentials.mintToken(projectId, kind ? { kind } : {});
    console.log(JSON.stringify(res, null, 2));
    if (res?.secret) {
      console.error("");
      console.error(`The token above is shown ONCE and expires in ${res.expires_in ?? "?"}s.`);
    }
  } catch (err) {
    reportSdkError(err);
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
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(SUB_HELP[sub] || HELP);
    process.exit(0);
  }
  switch (sub) {
    case "issue": await issue(args); break;
    case "list": await listCredentials(args); break;
    case "status": await credentialStatus(args); break;
    case "rotate": await rotate(args); break;
    case "revoke": await revoke(args); break;
    case "token": await token(args); break;
    default:
      failUnknownSubcommand("credentials", sub);
  }
}
