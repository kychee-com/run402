import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { resolveProjectId } from "./config.mjs";
import { resolveFilePathsInManifest, resolveMigrationsFile } from "./manifest.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";

const HELP = `run402 deploy — Deploy to an existing project on Run402

Usage:
  run402 deploy [options]
  cat manifest.json | run402 deploy [options]

Options:
  --manifest <file>    Path to manifest JSON file  (default: read from stdin)
  --project <id>       Project ID to deploy to     (default: active project)
  --help, -h           Show this help message

Manifest format (JSON):
  {
    "project_id": "prj_...",
    "migrations": "CREATE TABLE items (...)",
    "migrations_file": "setup.sql",
    "secrets": [{ "key": "OPENAI_API_KEY", "value": "sk-..." }],
    "functions": [{
      "name": "my-fn",
      "code": "export default async (req) => new Response('ok')"
    }],
    "files": [
      {
        "file": "manifest.json",
        "data": "{\\"version\\":\\"1\\",\\"tables\\":[{\\"name\\":\\"items\\",\\"expose\\":true,\\"policy\\":\\"public_read_write_UNRESTRICTED\\",\\"i_understand_this_is_unrestricted\\":true}]}"
      },
      { "file": "index.html", "data": "<html>...</html>" },
      { "file": "style.css", "path": "./dist/style.css" }
    ],
    "subdomain": "my-app"
  }

  project_id is required (provision first with 'run402 provision').
  All other fields are optional.

  Migrations can be inline or read from a file:
    "migrations": "CREATE TABLE ..."              ← inline SQL
    "migrations_file": "setup.sql"                ← read from disk
  Use migrations_file when your SQL contains JSONB literals or other
  characters that are painful to escape inside a JSON string.
  Paths are resolved relative to the manifest file's directory.
  If both are present, migrations_file wins.

  Files can use either inline "data" or a local "path":
    { "file": "index.html", "data": "<html>...</html>" }   ← inline content
    { "file": "style.css",  "path": "./dist/style.css" }   ← read from disk
  Paths are resolved relative to the manifest file's directory.
  Binary files (images, fonts, etc.) are auto-detected and base64-encoded.

  Authorization (manifest.json file pattern):
    Tables are dark by default — anon/authenticated can't read them until a
    manifest declares them with expose:true. Ship a "manifest.json" entry in
    files[] (preferred — auth-as-SDLC) and the platform reads, validates,
    applies, and strips it before the site deploys. Schema:
    https://run402.com/schemas/manifest.v1.json

    Per-table policies:
      user_owns_rows                    users see only their own rows. Requires
                                        "owner_column"; with
                                        "force_owner_on_insert": true the gateway
                                        sets it from auth.uid() automatically.
                                        uuid columns get index-friendly policies.
      public_read_authenticated_write   anyone reads; any authenticated user can
                                        INSERT/UPDATE/DELETE any row (not just
                                        their own). For collaborative content
                                        like shared boards or announcements.
      public_read_write_UNRESTRICTED    ⚠  fully open — anon_key can read AND
                                        write any row. Only for intentionally
                                        public tables (guestbooks, waitlists,
                                        feedback forms). REQUIRES
                                        "i_understand_this_is_unrestricted":
                                        true on the table entry.
      custom                            escape hatch. Provide "custom_sql" with
                                        CREATE POLICY statements.

  ⚠️  Without a manifest, tables are unreachable via anon_key. If your app
  reads or writes data from the browser, you need a manifest.json entry.

Examples:
  run402 deploy --manifest app.json
  run402 deploy --manifest app.json --project prj_123_1
  cat app.json | run402 deploy

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
 * Returns { manifest } on success, or { error } with a structured error object
 * on any fs / parse failure. Never throws.
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
        return { error: {
          status: "error",
          message: `File not found: ${manifestAbs}`,
          field: "manifest",
          path: manifestAbs,
          hint: "Check that --manifest points to an existing JSON file.",
        } };
      }
      return { error: {
        status: "error",
        message: err && err.message ? err.message : String(err),
        field: "manifest",
        path: manifestAbs,
        ...(err && err.code ? { code: err.code } : {}),
      } };
    }
  } else {
    raw = await readStdin();
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    return { error: {
      status: "error",
      message: `Manifest is not valid JSON: ${err.message}`,
      field: opts.manifest ? "manifest" : "stdin",
      ...(opts.manifest ? { path: resolve(opts.manifest) } : {}),
    } };
  }

  if (opts.manifest) {
    try {
      resolveMigrationsFile(manifest, baseDir);
      resolveFilePathsInManifest(manifest, baseDir);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        return { error: {
          status: "error",
          message: `File not found: ${err.absPath || err.path || "<unknown>"}`,
          field: err.field || "manifest",
          ...(err.absPath || err.path ? { path: err.absPath || err.path } : {}),
          hint: `Paths in manifest.${err.field || "files[].path"} are resolved relative to the manifest file's directory (${baseDir}).`,
        } };
      }
      return { error: {
        status: "error",
        message: err && err.message ? err.message : String(err),
        ...(err && err.field ? { field: err.field } : {}),
        ...(err && (err.absPath || err.path) ? { path: err.absPath || err.path } : {}),
        ...(err && err.code ? { code: err.code } : {}),
      } };
    }
  }

  return { manifest };
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

  const manifestResult = await loadManifest(opts);
  if (manifestResult.error) {
    console.error(JSON.stringify(manifestResult.error));
    process.exit(1);
  }
  const manifest = manifestResult.manifest;

  // If both sources set project_id and they disagree, refuse to deploy rather
  // than silently shipping to the wrong target.
  if (opts.project && manifest.project_id && opts.project !== manifest.project_id) {
    const err = {
      status: "error",
      message: `project_id conflict: manifest.project_id=${manifest.project_id} but --project=${opts.project}`,
      manifest_project_id: manifest.project_id,
      flag_project_id: opts.project,
      hint: "Remove one of them or make them match. The --project flag and manifest.project_id must agree (or only one of them must be set).",
    };
    console.error(JSON.stringify(err));
    process.exit(1);
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
