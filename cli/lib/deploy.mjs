import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { Agent, fetch as undiciFetch } from "undici";
import { API, allowanceAuthHeaders, findProject } from "./config.mjs";
import { resolveFilePathsInManifest, resolveMigrationsFile } from "./manifest.mjs";

// Custom undici dispatcher with longer timeouts for large-batch deploys.
// Default Node undici headersTimeout is ~5 min; large image uploads can exceed it.
// We MUST pair this Agent (from the installed undici major) with undici.fetch
// — not globalThis.fetch — because Node's built-in fetch ships its own bundled
// undici whose Dispatcher interface may differ by major version, which would
// cause UND_ERR_INVALID_ARG ("invalid onRequestStart method") at dispatch time.
const deployDispatcher = new Agent({
  headersTimeout: 600_000, // 10 min
  bodyTimeout:    600_000,
  connectTimeout:  30_000,
});

// Retry policy for transient network errors and 5xx gateway errors.
// We retry on these because they tend to be load-shedding/blip-related; we do
// NOT retry on other 4xx/5xx (402, 400, etc.) — those are deterministic.
const RETRY_CAUSE_CODES = new Set([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
]);
const RETRY_HTTP_STATUSES = new Set([502, 503, 504]);

// Test-only injection seam. Tests can replace the fetch implementation used by
// run() without monkey-patching globalThis.fetch (which would not intercept
// undici.fetch anyway). Pass null/undefined to reset.
let _runFetchImpl = undiciFetch;
export function _setFetchImpl(fn) { _runFetchImpl = fn ?? undiciFetch; }

function isRetriableError(err) {
  if (!err) return false;
  const code = err.code || (err.cause && err.cause.code);
  return typeof code === "string" && RETRY_CAUSE_CODES.has(code);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch with bounded retries on transient errors. Exported for testability.
 * - 2 retries (3 total attempts)
 * - Backoff ~1s then ~4s with small jitter
 * - Retries on RETRY_CAUSE_CODES network errors and RETRY_HTTP_STATUSES
 * - Silent: no stdout noise on retry (CLI is agent-first)
 */
export async function fetchWithRetry(url, init, { attempts = 3, fetchImpl = undiciFetch } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, init);
      if (attempt < attempts && RETRY_HTTP_STATUSES.has(res.status)) {
        // Drain body so the connection can be reused, then retry.
        try { await res.arrayBuffer(); } catch { /* noop */ }
        const delay = (attempt === 1 ? 1000 : 4000) + Math.floor(Math.random() * 250);
        await sleep(delay);
        continue;
      }
      return res;
    } catch (err) {
      if (attempt < attempts && isRetriableError(err)) {
        const delay = (attempt === 1 ? 1000 : 4000) + Math.floor(Math.random() * 250);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  // Unreachable: the loop above either returns a response or throws.
  throw new Error("fetchWithRetry: exhausted attempts without returning");
}

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
    "rls": {
      "template": "public_read_write",
      "tables": [{ "table": "items" }]
    },
    "secrets": [{ "key": "OPENAI_API_KEY", "value": "sk-..." }],
    "functions": [{
      "name": "my-fn",
      "code": "export default async (req) => new Response('ok')"
    }],
    "files": [
      { "file": "index.html", "data": "<html>...</html>" },
      { "file": "style.css", "path": "./dist/style.css" }
    ],
    "subdomain": "my-app",
    "inherit": true
  }

  project_id is required (provision first with 'run402 provision').
  All other fields are optional.
  inherit: copy unchanged site files from previous deployment (only upload changed files).

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

  RLS templates:
    user_owns_rows   — users see only their rows (requires owner_column per table)
    public_read      — anyone reads, authenticated users write
    public_read_write — anyone reads and writes

  ⚠️  Without RLS, tables are read-only via anon_key. If your app writes
  data from the browser, you almost certainly need an rls block.

Examples:
  run402 deploy --manifest app.json
  run402 deploy --manifest app.json --project prj_123_1
  cat app.json | run402 deploy

Prerequisites:
  - run402 init                     Set up allowance and funding
  - run402 tier set prototype       Subscribe to a tier
  - run402 provision                Provision a project first

Notes:
  - Requires an active tier subscription (run402 tier set <tier>)
  - Provision a project first with 'run402 provision', then deploy to it
  - Use 'run402 projects list' to see all provisioned projects
`;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

export async function run(args) {
  const opts = { manifest: null, project: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(HELP); process.exit(0); }
    if (args[i] === "--manifest" && args[i + 1]) opts.manifest = args[++i];
    if (args[i] === "--project" && args[i + 1]) opts.project = args[++i];
  }

  const raw = opts.manifest ? readFileSync(opts.manifest, "utf-8") : await readStdin();
  const manifest = JSON.parse(raw);
  if (opts.manifest) {
    const baseDir = dirname(resolve(opts.manifest));
    resolveMigrationsFile(manifest, baseDir);
    resolveFilePathsInManifest(manifest, baseDir);
  }

  // If both sources set project_id and they disagree, refuse to deploy rather
  // than silently shipping to the wrong target. Agents and humans should be
  // forced to be explicit when the two sources conflict (GH-42).
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

  // --project flag fills in manifest's project_id when the manifest doesn't
  // specify one. (When both are set they must already agree — enforced above.)
  if (opts.project) manifest.project_id = opts.project;

  // If no project_id in manifest, use active project
  if (!manifest.project_id) {
    const { id } = findProject(null);
    manifest.project_id = id;
  }

  // Remove legacy 'name' field if present
  delete manifest.name;

  const authHeaders = allowanceAuthHeaders("/deploy/v1");
  const body = JSON.stringify(manifest);
  const res = await fetchWithRetry(`${API}/deploy/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body,
    dispatcher: deployDispatcher,
  }, { fetchImpl: _runFetchImpl });

  // Content-type aware parsing: gateways (ALB, CloudFront, etc.) return HTML on
  // 504/413/etc., which would otherwise crash res.json() with SyntaxError.
  const contentType = res.headers.get("content-type") || "";
  let result = null;
  let parseError = null;
  let bodyText = null;
  if (contentType.includes("application/json")) {
    try {
      result = await res.json();
    } catch (e) {
      parseError = e;
      try { bodyText = await res.text(); } catch { bodyText = ""; }
    }
  } else {
    try { bodyText = await res.text(); } catch { bodyText = ""; }
  }

  if (!res.ok || parseError || result === null) {
    const err = { status: "error", http: res.status, content_type: contentType || null };
    if (result && typeof result === "object") {
      Object.assign(err, result);
    } else {
      const preview = typeof bodyText === "string" ? bodyText.slice(0, 500) : "";
      err.body_preview = preview;
      if (parseError) err.parse_error = "response body was not valid JSON";
    }
    console.error(JSON.stringify(err));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}
