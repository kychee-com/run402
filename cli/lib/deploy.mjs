import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { resolveProjectId } from "./config.mjs";
import { resolveFilePathsInManifest, resolveMigrationsFile } from "./manifest.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";

const HELP = `run402 deploy — Deploy to an existing project on Run402

Usage:
  run402 deploy [options]
  cat manifest.json | run402 deploy [options]

Options:
  --manifest <file>    Path to manifest JSON file  (default: read from stdin)
  --project <id>       Project ID to deploy to     (default: active project)
  --help, -h           Show this help message

Subcommands (recommended for new manifests):
  run402 deploy apply --manifest <file>     unified deploy primitive (v1.34+)
  run402 deploy resume <operation_id>       resume a stuck operation
  run402 deploy list [--project <id>]       list recent deploy operations
  run402 deploy events <operation_id>       fetch event stream for an operation

Manifest format (JSON, v2 ReleaseSpec — recommended):
  {
    "project_id": "prj_...",
    "database": {
      "migrations": [
        { "id": "001_init", "sql": "CREATE TABLE IF NOT EXISTS items (...)" }
      ],
      "expose": {
        "version": "1",
        "tables": [
          { "name": "items", "expose": true, "policy": "public_read_authenticated_write" }
        ]
      }
    },
    "secrets":   { "set": { "OPENAI_API_KEY": { "value": "sk-..." } } },
    "functions": {
      "replace": {
        "api": {
          "runtime": "node22",
          "source": { "data": "export default async (req) => new Response('ok')" }
        }
      }
    },
    "site": {
      "replace": {
        "index.html": { "data": "<!doctype html><html>...</html>" },
        "assets/logo.png": { "data": "iVBORw0KGgo...", "encoding": "base64" }
      }
    },
    "subdomains": { "set": ["my-app"] }
  }

  project_id is required (provision first with 'run402 provision').
  All other fields are optional. Top-level absence = "leave untouched".

  Source of truth for the v2 ReleaseSpec shape:
    https://run402.com/llms-cli.txt  (search for "Unified Deploy")

  Replace vs patch semantics per resource:
    "site": { "replace": {...} }        whole-site (omitted files removed)
    "site": { "patch": { "put": {...}, "delete": [...] } }   surgical updates
  Same for "functions" and "secrets". Migrations are always additive (each
  is keyed by id; re-shipping the same id+sql is a registry noop, same id
  with different sql is a hard MIGRATION_CHECKSUM_MISMATCH error).

  File entries accept inline "data", a local "path", or a "sql_path"
  (migrations only) — paths are resolved relative to the manifest file's
  directory. Binary files (images, fonts, PDFs) take "encoding": "base64";
  text defaults to UTF-8.

  Authorization (database.expose):
    Tables are dark by default — anon/authenticated can't read them until
    you declare them via "database.expose". Per-table policies:
      user_owns_rows                    users see only their own rows.
                                        Requires "owner_column"; with
                                        "force_owner_on_insert": true the
                                        gateway sets it from auth.uid()
                                        automatically.
      public_read_authenticated_write   anyone reads; any authenticated
                                        user can INSERT/UPDATE/DELETE any
                                        row (not just their own).
      public_read_write_UNRESTRICTED    ⚠  fully open — anon_key reads AND
                                        writes. REQUIRES
                                        "i_understand_this_is_unrestricted":
                                        true on the table entry.
      custom                            escape hatch. Provide "custom_sql"
                                        with CREATE POLICY statements.
  Schema for the expose section: https://run402.com/schemas/manifest.v1.json

  ⚠️  Without an "expose" entry, tables are unreachable via anon_key.

Legacy v1 bundle format (still accepted via compatibility shim):
  Existing manifests with top-level "migrations" (string), "secrets" (array),
  "functions" (array), "files" (array), "subdomain" (string), and the
  "files[].file/data/path" + inline "manifest.json" entry continue to work —
  the SDK translates them into a v2 ReleaseSpec under the hood. Prefer the
  v2 shape above for new manifests; the legacy form is preserved for the
  deprecation window so existing scripts don't break.

  "migrations_file": "setup.sql"   (legacy convenience) reads SQL from disk
  relative to the manifest file. Useful when JSONB literals make inline
  strings painful. Still supported on the legacy code path.

Examples:
  run402 deploy --manifest app.json
  run402 deploy --manifest app.json --project prj_123_1
  cat app.json | run402 deploy
  run402 deploy apply --manifest app.json   # unified primitive (recommended)

Prerequisites:
  - run402 init                     Set up allowance and funding
  - run402 tier set prototype       Subscribe to a tier
  - run402 provision                Provision a project first

Notes:
  - Routes through the unified deploy primitive (POST /deploy/v2/plans);
    bytes ride through the CAS substrate, only changed files get uploaded.
  - Requires an active tier subscription (run402 tier set <tier>)
  - Provision a project first with 'run402 provision', then deploy to it
  - Use 'run402 projects list' to see all provisioned projects
`;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Load + parse the manifest from --manifest file or stdin, and resolve any
 * referenced files[].path / migrations_file against the manifest's directory.
 *
 * Returns the parsed manifest on success. On any fs / parse failure, calls
 * `fail()` (which writes the canonical error envelope to stderr and exits 1).
 */
async function loadManifest(opts) {
  let raw;
  let baseDir = null;

  if (opts.manifest) {
    const manifestAbs = resolve(opts.manifest);
    baseDir = dirname(manifestAbs);
    try {
      raw = readFileSync(opts.manifest, "utf-8");
    } catch (err) {
      if (err && err.code === "ENOENT") {
        fail({
          code: "BAD_USAGE",
          message: `File not found: ${manifestAbs}`,
          hint: "Check that --manifest points to an existing JSON file.",
          details: { field: "manifest", path: manifestAbs },
        });
      }
      fail({
        code: "BAD_USAGE",
        message: err && err.message ? err.message : String(err),
        details: { field: "manifest", path: manifestAbs, ...(err && err.code ? { syscall_code: err.code } : {}) },
      });
    }
  } else {
    raw = await readStdin();
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    fail({
      code: "BAD_USAGE",
      message: `Manifest is not valid JSON: ${err.message}`,
      details: {
        field: opts.manifest ? "manifest" : "stdin",
        ...(opts.manifest ? { path: resolve(opts.manifest) } : {}),
        parse_error: err.message,
      },
    });
  }

  // GH-185: Reject empty manifests client-side. Without this guard,
  // `echo '{}' | run402 deploy` silently succeeds against the gateway with
  // no signal that nothing was deployed. The MCP `deploy` tool was hardened
  // for the same class of bug in #133; this is the CLI-side analog.
  //
  // "Meaningful" = at least one of these keys exists with non-empty content.
  // We accept both shapes because this CLI path receives v1 manifests
  // (translated by the bundleDeploy shim) and may also receive v2 manifests.
  //   v1: migrations, migrations_file, secrets, functions, files, subdomain
  //   v2: database, site, functions, secrets, subdomains, domains
  // For object-typed v2 sections (site, database, functions, secrets,
  // subdomains, domains) the "container is non-empty" check isn't enough —
  // `site:{replace:{}}` has one key but ships nothing. We recurse one level
  // so any object whose own values are all empty containers is still empty.
  const meaningfulV1 = ["migrations", "migrations_file", "secrets", "functions", "files", "subdomain"];
  const meaningfulV2 = ["database", "site", "functions", "secrets", "subdomains", "domains"];
  const meaningful = [...new Set([...meaningfulV1, ...meaningfulV2])];

  function hasContent(v) {
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") {
      const keys = Object.keys(v);
      if (keys.length === 0) return false;
      return keys.some((k) => hasContent(v[k]));
    }
    if (typeof v === "string") return v.length > 0;
    return true;
  }

  const hasMeaningfulContent = manifest && typeof manifest === "object" && !Array.isArray(manifest) && meaningful.some((key) => hasContent(manifest[key]));
  if (!hasMeaningfulContent) {
    fail({
      code: "MANIFEST_EMPTY",
      message: `Manifest contains no deployable sections. Expected at least one of: ${meaningful.join(", ")}`,
      hint: "Did you mean to write a 'site.replace' or 'database.migrations' block? See https://run402.com/schemas/manifest.v1.json",
      details: {
        field: opts.manifest ? "manifest" : "stdin",
        ...(opts.manifest ? { path: resolve(opts.manifest) } : {}),
        meaningful_keys: meaningful,
      },
    });
  }

  if (opts.manifest) {
    try {
      resolveMigrationsFile(manifest, baseDir);
      resolveFilePathsInManifest(manifest, baseDir);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        fail({
          code: "BAD_USAGE",
          message: `File not found: ${err.absPath || err.path || "<unknown>"}`,
          hint: `Paths in manifest.${err.field || "files[].path"} are resolved relative to the manifest file's directory (${baseDir}).`,
          details: {
            field: err.field || "manifest",
            ...(err.absPath || err.path ? { path: err.absPath || err.path } : {}),
          },
        });
      }
      fail({
        code: "BAD_USAGE",
        message: err && err.message ? err.message : String(err),
        details: {
          ...(err && err.field ? { field: err.field } : {}),
          ...(err && (err.absPath || err.path) ? { path: err.absPath || err.path } : {}),
          ...(err && err.code ? { syscall_code: err.code } : {}),
        },
      });
    }
  }

  return manifest;
}

export async function run(args) {
  // Subcommand dispatch (v1.34+):
  //   run402 deploy apply  ...    → unified deploy primitive (deploy.apply)
  //   run402 deploy resume <op>   → resume an activation_pending operation
  //   run402 deploy list          → list recent deploy operations
  //   run402 deploy events <op>   → fetch recorded event stream for an operation
  //   run402 deploy --manifest …  → legacy bundle deploy (routes through v2)
  const sub = args[0];
  switch (sub) {
    case "apply":
    case "resume":
    case "list":
    case "events": {
      const { runDeployV2 } = await import("./deploy-v2.mjs");
      await runDeployV2(sub, args.slice(1));
      return;
    }
  }

  const opts = { manifest: null, project: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(HELP); process.exit(0); }
    if (args[i] === "--manifest" && args[i + 1]) opts.manifest = args[++i];
    if (args[i] === "--project" && args[i + 1]) opts.project = args[++i];
  }

  const manifest = await loadManifest(opts);

  // If both sources set project_id and they disagree, refuse to deploy rather
  // than silently shipping to the wrong target.
  if (opts.project && manifest.project_id && opts.project !== manifest.project_id) {
    fail({
      code: "BAD_USAGE",
      message: `project_id conflict: manifest.project_id=${manifest.project_id} but --project=${opts.project}`,
      hint: "Remove one of them or make them match. The --project flag and manifest.project_id must agree (or only one of them must be set).",
      details: {
        manifest_project_id: manifest.project_id,
        flag_project_id: opts.project,
      },
    });
  }

  if (opts.project) manifest.project_id = opts.project;
  if (!manifest.project_id) {
    manifest.project_id = resolveProjectId(null);
  }

  // Strip fields that aren't part of the bundleDeploy contract.
  const projectId = manifest.project_id;
  delete manifest.project_id;
  delete manifest.name;
  delete manifest.migrations_file;

  try {
    const result = await getSdk().apps.bundleDeploy(projectId, manifest);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}
