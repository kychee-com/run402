/**
 * `run402 deploy apply` and `run402 deploy resume` — CLI wrappers over the
 * unified deploy primitive (`r.deploy.apply` / `r.deploy.resume`).
 *
 * The legacy `run402 deploy --manifest …` command is preserved in
 * `cli/lib/deploy.mjs` and continues to work; this file adds the new
 * subcommand surface.
 *
 * Manifest format mirrors the MCP `deploy` tool's input schema:
 *   {
 *     "project_id": "...",
 *     "base":  { "release": "current" } | { "release": "empty" } | { "release_id": "..." },
 *     "database": { "migrations": [...], "expose": {...}, "zero_downtime": false },
 *     "secrets":   { "set": {...}, "delete": [...], "replace_all": {...} },
 *     "functions": { "replace": {...}, "patch": { "set": {...}, "delete": [...] } },
 *     "site":      { "replace": {...} } | { "patch": { "put": {...}, "delete": [...] } },
 *     "subdomains": { "set": ["..."], "add": [...], "remove": [...] },
 *     "idempotency_key": "..."
 *   }
 *
 * File entries: `{ "data": "...", "encoding": "utf-8" | "base64", "contentType": "..." }`
 * — same shape used by `bundle_deploy`. UTF-8 is the default; binary files
 * pass `"encoding": "base64"`.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname, isAbsolute, join } from "node:path";
import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";
import { allowanceAuthHeaders, resolveProjectId } from "./config.mjs";

const APPLY_HELP = `run402 deploy apply — Unified deploy primitive (v1.34+)

Usage:
  run402 deploy apply --manifest <path> [--project <id>] [--quiet]
  run402 deploy apply --spec '<json>' [--project <id>] [--quiet]
  cat spec.json | run402 deploy apply [--project <id>]

Manifest format mirrors the MCP \`deploy\` tool's ReleaseSpec:
  {
    "project_id": "prj_...",
    "base": { "release": "current" },
    "database": { "migrations": [{ "id": "001_init", "sql": "CREATE TABLE ..." }], "expose": {...} },
    "secrets":   { "set": { "OPENAI_API_KEY": { "value": "sk-..." } } },
    "functions": { "replace": { "api": { "source": { "data": "export default ..." } } } },
    "site":      { "replace": { "index.html": { "data": "<html>..." } } },
    "subdomains": { "set": ["my-app"] }
  }

Options:
  --manifest <path>       Read the spec from this JSON file
  --spec '<json>'         Inline JSON spec (single-quote in shell)
  --project <id>          Override project_id from the manifest
  --quiet                 Suppress per-event JSON-line stderr (final result still on stdout)

Output:
  stdout: { "status": "ok", "release_id": "rel_...", "operation_id": "op_...", "urls": {...} }
  stderr: one JSON event per line (suppressed with --quiet)

Patch examples (only the listed file changes):
  { "project_id": "prj_...", "site": { "patch": { "put": { "index.html": { "data": "..." } } } } }
  { "project_id": "prj_...", "site": { "patch": { "delete": ["old.html"] } } }
`;

const RESUME_HELP = `run402 deploy resume — Resume a stuck deploy operation

Usage:
  run402 deploy resume <operation_id> [--quiet]

Used when a previous \`deploy apply\` ended in \`activation_pending\` or
\`schema_settling\` (e.g. transient gateway failure between SQL commit and
the pointer-swap activation). The gateway re-runs only the failed phase
forward — SQL is never replayed.

Output:
  stdout: { "status": "ok", "release_id": "...", "operation_id": "...", "urls": {...} }
  stderr: one JSON event per line (suppressed with --quiet)
`;

const LIST_HELP = `run402 deploy list — List recent deploy operations for a project

Usage:
  run402 deploy list [--project <id>] [--limit <n>]

Options:
  --project <id>          Project ID to list operations for (default: active project)
  --limit <n>             Maximum number of operations to return

Output:
  stdout: { "status": "ok", "operations": [...], "cursor": "..." | null }
`;

const EVENTS_HELP = `run402 deploy events — Fetch the recorded event stream for a deploy operation

Usage:
  run402 deploy events <operation_id> [--project <id>]

Options:
  --project <id>          Project ID that owns the operation (default: active project)

Output:
  stdout: { "status": "ok", "events": [...] }
`;

export async function runDeployV2(sub, args) {
  if (sub === "apply") return await applyCmd(args);
  if (sub === "resume") return await resumeCmd(args);
  if (sub === "list") return await listCmd(args);
  if (sub === "events") return await eventsCmd(args);
  console.error(JSON.stringify({ status: "error", message: `Unknown deploy subcommand: ${sub}` }));
  process.exit(1);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

function makeStderrEventWriter(quiet) {
  if (quiet) return undefined;
  return (event) => {
    console.error(JSON.stringify(event));
  };
}

async function applyCmd(args) {
  const opts = { manifest: null, spec: null, project: null, quiet: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(APPLY_HELP); process.exit(0); }
    if (args[i] === "--manifest" && args[i + 1]) { opts.manifest = args[++i]; continue; }
    if (args[i] === "--spec" && args[i + 1]) { opts.spec = args[++i]; continue; }
    if (args[i] === "--project" && args[i + 1]) { opts.project = args[++i]; continue; }
    if (args[i] === "--quiet") { opts.quiet = true; continue; }
  }

  let raw;
  if (opts.spec) {
    raw = opts.spec;
  } else if (opts.manifest) {
    try {
      const manifestPath = isAbsolute(opts.manifest) ? opts.manifest : resolve(process.cwd(), opts.manifest);
      raw = readFileSync(manifestPath, "utf-8");
    } catch (err) {
      console.error(JSON.stringify({ status: "error", message: `Failed to read manifest: ${err.message}` }));
      process.exit(1);
    }
  } else {
    raw = await readStdin();
  }

  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (err) {
    console.error(JSON.stringify({ status: "error", message: `Manifest is not valid JSON: ${err.message}` }));
    process.exit(1);
  }

  if (opts.manifest) resolveFileDataPaths(spec, dirname(resolve(opts.manifest)));

  if (opts.project && spec.project_id && spec.project_id !== opts.project) {
    console.error(JSON.stringify({
      status: "error",
      message: `project_id conflict: spec.project_id=${spec.project_id} but --project=${opts.project}`,
    }));
    process.exit(1);
  }
  if (opts.project) spec.project_id = opts.project;
  if (!spec.project_id) spec.project_id = resolveProjectId(null);

  // Translate { project_id, ... } envelope → ReleaseSpec ({ project, ... })
  // The SDK ReleaseSpec uses `project` rather than `project_id`; both shapes
  // are accepted at the manifest layer (project_id is friendlier for agents
  // sharing JSON manifests with the MCP tool).
  const releaseSpec = mapManifestToReleaseSpec(spec);
  const idempotencyKey = spec.idempotency_key;

  // Preserve the aggressive early exit when no allowance is configured.
  allowanceAuthHeaders("/deploy/v2/plans");

  try {
    const result = await getSdk().deploy.apply(releaseSpec, {
      onEvent: makeStderrEventWriter(opts.quiet),
      idempotencyKey,
    });
    console.log(JSON.stringify({ status: "ok", ...result }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function resumeCmd(args) {
  const opts = { operationId: null, quiet: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(RESUME_HELP); process.exit(0); }
    if (args[i] === "--quiet") { opts.quiet = true; continue; }
    if (!args[i].startsWith("-") && !opts.operationId) opts.operationId = args[i];
  }
  if (!opts.operationId) {
    console.error(JSON.stringify({ status: "error", message: "Usage: run402 deploy resume <operation_id>" }));
    process.exit(1);
  }

  allowanceAuthHeaders("/deploy/v2/operations");

  try {
    const result = await getSdk().deploy.resume(opts.operationId, {
      onEvent: makeStderrEventWriter(opts.quiet),
    });
    console.log(JSON.stringify({ status: "ok", ...result }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function listCmd(args) {
  const opts = { project: null, limit: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(LIST_HELP); process.exit(0); }
    if (args[i] === "--project" && args[i + 1]) { opts.project = args[++i]; continue; }
    if (args[i] === "--limit" && args[i + 1]) { opts.limit = Number(args[++i]); continue; }
  }

  const project = resolveProjectId(opts.project);
  allowanceAuthHeaders("/deploy/v2/operations");

  try {
    const sdkOpts = { project };
    if (opts.limit !== null && Number.isFinite(opts.limit)) sdkOpts.limit = opts.limit;
    const result = await getSdk().deploy.list(sdkOpts);
    console.log(JSON.stringify({ status: "ok", ...result }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function eventsCmd(args) {
  const opts = { operationId: null, project: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(EVENTS_HELP); process.exit(0); }
    if (args[i] === "--project" && args[i + 1]) { opts.project = args[++i]; continue; }
    if (!args[i].startsWith("-") && !opts.operationId) opts.operationId = args[i];
  }
  if (!opts.operationId) {
    console.error(JSON.stringify({ status: "error", message: "Usage: run402 deploy events <operation_id>" }));
    process.exit(1);
  }

  const project = resolveProjectId(opts.project);
  allowanceAuthHeaders("/deploy/v2/operations");

  try {
    const result = await getSdk().deploy.events(opts.operationId, { project });
    console.log(JSON.stringify({ status: "ok", ...result }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── Manifest → ReleaseSpec ──────────────────────────────────────────────────

function mapManifestToReleaseSpec(spec) {
  const out = { project: spec.project_id };
  if (spec.base !== undefined) out.base = spec.base;
  if (spec.subdomains !== undefined) out.subdomains = spec.subdomains;
  if (spec.secrets !== undefined) out.secrets = spec.secrets;
  if (spec.routes !== undefined) out.routes = spec.routes;
  if (spec.checks !== undefined) out.checks = spec.checks;

  if (spec.database) {
    out.database = {};
    if (spec.database.expose !== undefined) out.database.expose = spec.database.expose;
    if (spec.database.zero_downtime !== undefined) out.database.zero_downtime = spec.database.zero_downtime;
    if (spec.database.migrations) {
      out.database.migrations = spec.database.migrations.map((m) => {
        const mm = { id: m.id };
        if (m.sql !== undefined) mm.sql = m.sql;
        if (m.sql_ref !== undefined) mm.sql_ref = m.sql_ref;
        if (m.checksum !== undefined) mm.checksum = m.checksum;
        if (m.transaction !== undefined) mm.transaction = m.transaction;
        return mm;
      });
    }
  }

  if (spec.functions) {
    out.functions = {};
    if (spec.functions.replace) out.functions.replace = mapFunctionMap(spec.functions.replace);
    if (spec.functions.patch) {
      out.functions.patch = {};
      if (spec.functions.patch.set) out.functions.patch.set = mapFunctionMap(spec.functions.patch.set);
      if (spec.functions.patch.delete) out.functions.patch.delete = spec.functions.patch.delete;
    }
  }

  if (spec.site) {
    if (spec.site.replace) {
      out.site = { replace: mapFileMap(spec.site.replace) };
    } else if (spec.site.patch) {
      const patch = {};
      if (spec.site.patch.put) patch.put = mapFileMap(spec.site.patch.put);
      if (spec.site.patch.delete) patch.delete = spec.site.patch.delete;
      out.site = { patch };
    }
  }

  return out;
}

function mapFunctionMap(map) {
  const out = {};
  for (const [name, fn] of Object.entries(map)) {
    const f = {};
    if (fn.runtime) f.runtime = fn.runtime;
    if (fn.source !== undefined) f.source = fileEntryToContentSource(fn.source);
    if (fn.files) f.files = mapFileMap(fn.files);
    if (fn.entrypoint !== undefined) f.entrypoint = fn.entrypoint;
    if (fn.config !== undefined) f.config = fn.config;
    if (fn.schedule !== undefined) f.schedule = fn.schedule;
    out[name] = f;
  }
  return out;
}

function mapFileMap(map) {
  const out = {};
  for (const [path, entry] of Object.entries(map)) {
    out[path] = fileEntryToContentSource(entry);
  }
  return out;
}

function fileEntryToContentSource(entry) {
  if (entry === null || entry === undefined) return entry;
  if (typeof entry === "string") return entry;
  if (entry instanceof Uint8Array) return entry;
  if (typeof entry === "object") {
    if (entry.encoding === "base64" && typeof entry.data === "string") {
      const bytes = Buffer.from(entry.data, "base64");
      const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return entry.contentType ? { data: u8, contentType: entry.contentType } : u8;
    }
    if (typeof entry.data === "string") {
      return entry.contentType ? { data: entry.data, contentType: entry.contentType } : entry.data;
    }
    // Pre-resolved ContentRef shape — pass through.
    if (typeof entry.sha256 === "string" && typeof entry.size === "number") {
      return entry;
    }
  }
  return entry;
}

/**
 * Resolve any `{ "path": "..." }` entries in the manifest to inline data.
 * Mirrors the legacy deploy.mjs behavior so `run402 deploy apply` accepts
 * the same files-with-paths shape that `run402 deploy` does today.
 */
function resolveFileDataPaths(spec, baseDir) {
  // Site files
  if (spec.site?.replace) resolveMap(spec.site.replace, baseDir);
  if (spec.site?.patch?.put) resolveMap(spec.site.patch.put, baseDir);
  // Function files
  const visitFns = (fnMap) => {
    if (!fnMap) return;
    for (const fn of Object.values(fnMap)) {
      if (fn.source && typeof fn.source === "object" && fn.source.path) {
        const resolved = readFileEntry(fn.source, baseDir);
        if (resolved) fn.source = resolved;
      }
      if (fn.files) resolveMap(fn.files, baseDir);
    }
  };
  visitFns(spec.functions?.replace);
  visitFns(spec.functions?.patch?.set);
  // Migration sql_path / sql_file
  if (spec.database?.migrations) {
    for (const m of spec.database.migrations) {
      if (!m.sql && m.sql_path) {
        try {
          const p = isAbsolute(m.sql_path) ? m.sql_path : join(baseDir, m.sql_path);
          m.sql = readFileSync(p, "utf-8");
          delete m.sql_path;
        } catch (err) {
          console.error(JSON.stringify({
            status: "error",
            message: `Failed to read migration sql_path '${m.sql_path}': ${err.message}`,
          }));
          process.exit(1);
        }
      }
    }
  }
}

function resolveMap(map, baseDir) {
  for (const [key, entry] of Object.entries(map)) {
    if (entry && typeof entry === "object" && typeof entry.path === "string" && entry.data === undefined) {
      const resolved = readFileEntry(entry, baseDir);
      if (resolved) map[key] = resolved;
    }
  }
}

function readFileEntry(entry, baseDir) {
  try {
    const p = isAbsolute(entry.path) ? entry.path : join(baseDir, entry.path);
    const buf = readFileSync(p);
    const out = {};
    // Detect text vs binary via simple UTF-8 round-trip; mirrors the bundle
    // deploy behavior. Image/font types get base64; HTML/CSS/JS stay UTF-8.
    const looksTextual = !entry.contentType?.match(/^(image|font|application\/(pdf|wasm|octet-stream|zip))/);
    if (looksTextual) {
      out.data = buf.toString("utf-8");
      out.encoding = "utf-8";
    } else {
      out.data = buf.toString("base64");
      out.encoding = "base64";
    }
    if (entry.contentType) out.contentType = entry.contentType;
    return out;
  } catch (err) {
    console.error(JSON.stringify({
      status: "error",
      message: `Failed to read file '${entry.path}': ${err.message}`,
    }));
    process.exit(1);
  }
}
