/**
 * `run402 deploy apply` and `run402 deploy resume` — CLI wrappers over the
 * unified deploy primitive (`r.deploy.apply` / `r.deploy.resume`).
 *
 * Manifest format mirrors the MCP `deploy` tool's input schema:
 *   {
 *     "project_id": "...",
 *     "base":  { "release": "current" } | { "release": "empty" } | { "release_id": "..." },
 *     "database": { "migrations": [...], "expose": {...}, "zero_downtime": false },
 *     "secrets":   { "require": ["OPENAI_API_KEY"], "delete": ["OLD_KEY"] },
 *     "functions": { "replace": {...}, "patch": { "set": {...}, "delete": [...] } },
 *     "site":      { "replace": {...}, "public_paths": { "mode": "explicit", "replace": { "/events": { "asset": "events.html" } } } }
 *                  | { "patch": { "put": {...}, "delete": [...] }, "public_paths": { "mode": "implicit" } }
 *                  | { "public_paths": { "mode": "explicit", "replace": {} } },
 *     "subdomains": { "set": ["..."], "add": [...], "remove": [...] },
 *     "routes": { "replace": [{ "pattern": "/api/*", "methods": ["GET", "POST"], "target": { "type": "function", "name": "api" } }] },
 *     "i18n": { "defaultLocale": "en", "locales": ["en", "es"], "detect": ["cookie:wl_locale", "accept-language"] },
 *     "idempotency_key": "..."
 *   }
 *
 * File entries: `{ "data": "...", "encoding": "utf-8" | "base64", "contentType": "..." }`.
 * UTF-8 is the default; binary files pass `"encoding": "base64"`.
 */

import { existsSync, fstatSync, readFileSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import {
  buildDeployResolveSummary,
  githubActionsCredentials,
  normalizeDeployManifest,
  normalizeDeployResolveRequest,
} from "#sdk/node";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { API, allowanceAuthHeaders, getActiveProjectId, resolveProjectId, isCoreApiTarget } from "./config.mjs";
import { normalizeArgv } from "./argparse.mjs";
import { loadLiveControlPlaneSession } from "../core-dist/control-plane-session.js";
import { withAutoApprove } from "./operator.mjs";
import { editRequestAction, nextAction, retryAction } from "./next-actions.mjs";

const APPLY_HELP = `run402 deploy apply — Unified deploy primitive (v1.34+)

Usage:
  run402 deploy apply --manifest <path> [--project <id>] [--quiet|--final-only] [--allow-warning <code>] [--allow-warnings]
  run402 deploy apply --spec '<json>' [--project <id>] [--quiet|--final-only] [--allow-warning <code>] [--allow-warnings]
  run402 deploy apply --dir <build-output> [--manifest <path>] [--project <id>]
  cat spec.json | run402 deploy apply [--project <id>]

Manifest format mirrors the MCP \`deploy\` tool's ReleaseSpec:
  {
    "project_id": "prj_...",
    "base": { "release": "current" },
    "database": { "migrations": [{ "id": "001_init", "sql": "CREATE TABLE ..." }], "expose": {...} },
    "secrets":   { "require": ["OPENAI_API_KEY"], "delete": ["OLD_KEY"] },
    "functions": { "replace": { "api": { "source": { "data": "export default ..." } } } },
    "site": {
      "replace": { "index.html": { "data": "<html>..." }, "events.html": { "data": "<h1>Events</h1>" } },
      "public_paths": { "mode": "explicit", "replace": { "/events": { "asset": "events.html", "cache_class": "html" } } }
    },
    "subdomains": { "set": ["my-app"] },
    "routes": {
      "replace": [
        { "pattern": "/api/*", "methods": ["GET", "POST"], "target": { "type": "function", "name": "api" } }
      ]
    }
  }

Complete static site + function + route manifest:
  {
    "project_id": "prj_...",
    "site": { "replace": { "index.html": { "data": "<html><body><script src='/api/hello'></script></body></html>" } } },
    "functions": {
      "replace": {
        "api": {
          "runtime": "node22",
          "source": { "data": "export default async function handler(req) { const url = new URL(req.url); return Response.json({ ok: true, path: url.pathname }); }" }
        }
      }
    },
    "routes": { "replace": [{ "pattern": "/api/*", "target": { "type": "function", "name": "api" } }] }
  }

Options:
  --manifest <path>       Read the spec from this JSON file
  --spec '<json>'         Inline JSON spec (single-quote in shell)
  --dir <path>            Read \`dist/run402/adapter.json\` from this directory and
                          merge the Astro release slice (site + functions + routes)
                          into the spec. Combine with --manifest to declare
                          database/secrets/subdomains/i18n in the manifest while
                          the slice carries the build output. Requires
                          @run402/astro installed in the project.
  --project <id>          Override project_id from the manifest
  --quiet                 Suppress per-event JSON-line stderr (final result still on stdout)
  --final-only            Alias for --quiet; final success/error envelope is still preserved
  --allow-warning <code>  Continue past this reviewed warning code (repeatable)
  --allow-warnings        Continue past plan warnings that require confirmation

Output:
  stdout: { "release_id": "rel_...", "operation_id": "op_...", "urls": {...}, "warnings": [...] }
  stderr: one JSON event per line (suppressed with --quiet or --final-only)

Secrets:
  Secret values do not belong in deploy manifests. Set them first:
    printf %s "$OPENAI_API_KEY" | run402 secrets set prj_... OPENAI_API_KEY --stdin
    run402 secrets set prj_... OPENAI_API_KEY --file ./.secrets/openai-key
  Then deploy a value-free declaration:
    { "project_id": "prj_...", "secrets": { "require": ["OPENAI_API_KEY"] } }

Patch examples (only the listed file changes):
  { "project_id": "prj_...", "site": { "patch": { "put": { "index.html": { "data": "..." } } } } }
  { "project_id": "prj_...", "site": { "patch": { "delete": ["old.html"] } } }

Static public paths:
  Release static asset paths and browser-visible public paths are distinct. Use "site.public_paths" for ordinary clean static URLs:
    { "project_id": "prj_...", "site": { "replace": { "events.html": { "data": "<h1>Events</h1>" } }, "public_paths": { "mode": "explicit", "replace": { "/events": { "asset": "events.html", "cache_class": "html" } } } } }
  In explicit mode, /events.html is not directly public unless declared. "mode": "implicit" restores filename-derived reachability and can widen access.

Routes:
  Omit routes or pass "routes": null to carry forward base routes.
  Use "routes": { "replace": [] } to clear dynamic routes.
  Route entries are array-based, not path-keyed maps. Use exact /admin plus final-wildcard /admin/* for a routed section root.
  Prefer site.public_paths for ordinary clean static URLs. Static route targets are for exact, method-aware route-table aliases such as GET /login static plus POST /login function.
  Routed functions use Node 22 Fetch Request -> Response. req.url is the full public URL on managed domains, deployment hosts, and verified custom domains.
  Routes activate atomically with the release. Direct /functions/v1/:name remains API-key protected.
  Runtime route failure codes: ROUTE_MANIFEST_LOAD_FAILED, ROUTED_INVOKE_WORKER_SECRET_MISSING, ROUTED_INVOKE_AUTH_FAILED, ROUTED_ROUTE_STALE, ROUTE_METHOD_NOT_ALLOWED, ROUTED_RESPONSE_TOO_LARGE.

Function capabilities:
  functions.replace.<name>.capabilities is an array of runtime capability strings.
  Framework adapters use it for contracts such as "astro.ssr.v1"; omit it for
  ordinary user-authored functions unless a documented helper requires it.

Internationalization (routed functions):
  "i18n": { "defaultLocale": "en", "locales": ["en", "es", "fr"], "detect": ["cookie:wl_locale", "accept-language"] }
  Omit i18n to carry forward from base release; pass "i18n": null to clear the slice on the new release.
  defaultLocale MUST be byte-identical to one entry in locales[]. Locale tags must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, max 50 tags; no BCP-47 semantic validation.
  detect[] (default ["accept-language"], max 10, [] means "always default"): walked in order, first match wins. Sources: "accept-language" and "cookie:<name>" (RFC 6265 cookie-name grammar).
  Routed functions read the negotiated locale via request headers: req.headers.get("x-run402-locale") and req.headers.get("x-run402-default-locale"). Headers are omitted when no i18n slice is active.
  Static-route hits do NOT receive locale negotiation; only routed HTTP function invocations do. Run402 does NOT inject Vary headers.
`;

const RESUME_HELP = `run402 deploy resume — Resume a stuck deploy operation

Usage:
  run402 deploy resume <operation_id> [--quiet]

Used when a previous \`deploy apply\` ended in \`activation_pending\` or
\`schema_settling\` (e.g. transient gateway failure between SQL commit and
the pointer-swap activation). The gateway re-runs only the failed phase
forward — SQL is never replayed.

Output:
  stdout: { "release_id": "...", "operation_id": "...", "urls": {...} }
  stderr: one JSON event per line (suppressed with --quiet)
`;

const LIST_HELP = `run402 deploy list — List recent deploy operations for a project

Usage:
  run402 deploy list [--project <id>] [--limit <n>]

Options:
  --project <id>          Project ID to list operations for (default: active project)
  --limit <n>             Maximum number of operations to return

Output:
  stdout: { "operations": [...], "cursor": "..." | null }
`;

const EVENTS_HELP = `run402 deploy events — Fetch the recorded event stream for a deploy operation

Usage:
  run402 deploy events <operation_id> [--project <id>]

Options:
  --project <id>          Project ID that owns the operation (default: active project)

Output:
  stdout: { "events": [...] }
`;

const RELEASE_HELP = `run402 deploy release — Inspect deploy release inventory and diffs

Usage:
  run402 deploy release get <release_id> [--project <id>] [--site-limit <n>]
  run402 deploy release active [--project <id>] [--site-limit <n>]
  run402 deploy release diff --from <empty|active|release_id> --to <active|release_id> [--project <id>] [--limit <n>]

Subcommands:
  get       Fetch the inventory for a specific release id
  active    Fetch the current-live release inventory for the project
  diff      Diff two release targets

Output:
  get/active: { "release": {...} }  # includes route inventory and inventory warnings when returned
  diff:       { "diff": {...} }     # includes route added/removed/changed diff buckets
`;

const RELEASE_GET_HELP = `run402 deploy release get — Fetch a release inventory by id

Usage:
  run402 deploy release get <release_id> [--project <id>] [--site-limit <n>]

Options:
  --project <id>          Project ID that owns the release (default: active project)
  --site-limit <n>        Maximum site path entries to include (gateway default: 5000)

Output:
  stdout: { "release": {...} }  # preserves full routes inventory and warnings
`;

const RELEASE_ACTIVE_HELP = `run402 deploy release active — Fetch the active release inventory

Usage:
  run402 deploy release active [--project <id>] [--site-limit <n>]

Options:
  --project <id>          Project ID to inspect (default: active project)
  --site-limit <n>        Maximum site path entries to include (gateway default: 5000)

Output:
  stdout: { "release": {...} }  # preserves full routes inventory and warnings
`;

const RELEASE_DIFF_HELP = `run402 deploy release diff — Diff two release targets

Usage:
  run402 deploy release diff --from <empty|active|release_id> --to <active|release_id> [--project <id>] [--limit <n>]

Options:
  --from <target>         Diff source: empty, active, or rel_...
  --to <target>           Diff target: active or rel_...
  --project <id>          Project ID to inspect (default: active project)
  --limit <n>             Maximum entries per site diff bucket (gateway default: 1000)

Output:
  stdout: { "diff": {...} }  # preserves routes.added/removed/changed
`;

const DIAGNOSE_HELP = `run402 deploy diagnose — Diagnose a Run402 public URL

Usage:
  run402 deploy diagnose --project <id> <url> [--method GET]
  run402 deploy diagnose <url> [--method GET]       # uses active project

Diagnoses how a project-owned Run402 subdomain or custom domain resolves
against the current live release. This is not an HTTP fetch, cache purge, or
CAS URL lookup. Query strings and fragments in URL input are ignored for route
resolution and reported in structured warnings.

Options:
  --project <id>          Project ID for local apikey lookup (default: active project)
  --method <method>       HTTP method to diagnose (default: GET)

Output:
  stdout: { "would_serve": true|false, "diagnostic_status": 200|404|..., "match": "...", "summary": "...", "request": {...}, "warnings": [...], "resolution": {...}, "next_steps": [...] }
`;

const RESOLVE_HELP = `run402 deploy resolve — Low-level deploy URL diagnostics

Usage:
  run402 deploy resolve --project <id> --url <url> [--method GET]
  run402 deploy resolve --project <id> --host <host> [--path /x] [--method GET]
  run402 deploy resolve --url <url> [--method GET]       # uses active project

Options:
  --project <id>          Project ID for local apikey lookup (default: active project)
  --url <url>             Absolute HTTP(S) public URL to diagnose
  --host <host>           Clean hostname without scheme/path/query/fragment
  --path </path>          Public URL path for host/path mode
  --method <method>       HTTP method to diagnose (default: GET)

Do not combine --url with --host or --path. Successful diagnostic misses still
exit 0; inspect would_serve and diagnostic_status in the result payload.
`;

export async function runDeployV2(sub, args) {
  if (sub === "apply") return await applyCmd(args);
  if (sub === "promote") return await promoteCmd(args);
  if (sub === "resume") return await resumeCmd(args);
  if (sub === "list") return await listCmd(args);
  if (sub === "events") return await eventsCmd(args);
  if (sub === "release") return await releaseCmd(args);
  if (sub === "diagnose") return await diagnoseCmd(args);
  if (sub === "resolve") return await resolveCmd(args);
  fail({
    code: "BAD_USAGE",
    message: `Unknown deploy subcommand: ${sub}`,
    details: { subcommand: sub },
  });
}

const PROMOTE_HELP = `run402 deploy promote — Operator pointer-swap recovery (v1.58+)

Usage:
  run402 deploy promote <release-id> [--project <id>] [--allow-warning <code>] [--allow-warnings] [--quiet]

Re-points the project's live release at an existing release row without
re-running the apply pipeline. Designed for "oops on a real project ID"
recovery — when an apply shipped content the operator regrets, promote
back to the prior release in seconds instead of re-deploying.

Promotable statuses: ready, active, superseded. Releases with status
'failed' or 'staging' are rejected (they never fully landed).

Surfaces structured warnings:

  MIGRATIONS_NOT_REVERSIBLE (requires_confirmation: true)
    The target release predates migrations applied since. Those
    migrations remain applied — the post-promote release runs against
    the current schema. Ack with --allow-warning MIGRATIONS_NOT_REVERSIBLE.

  FUNCTION_VERSION_MISMATCH (informational, no ack needed)
    Overlapping function names have different code_hashes. The Lambda
    code is whatever's currently $LATEST.

Worked example: recover from a destructive apply

  # rel_old (good)  →  rel_new (bad, destructive)  →  promote back
  run402 deploy promote rel_old_abc123 --project prj_xyz \\
    --allow-warning MIGRATIONS_NOT_REVERSIBLE

Options:
  <release-id>            Required positional. The release to promote to.
                          Format: rel_*
  --project <id>          Project id. Falls back to active project, then
                          RUN402_PROJECT_ID env var.
  --allow-warning <code>  Acknowledge a specific blocking warning
                          (repeatable).
  --allow-warnings        Acknowledge ALL blocking promote warnings.
                          Use this for full recovery mode when you've
                          already inspected the diff.
  --quiet | --final-only  Suppress per-event stderr; only print the
                          final JSON envelope on stdout.

Output:
  stdout: {
    "release_id": "rel_old_abc123",
    "operation_id": "op_...",
    "previous_release_id": "rel_new_xxx",
    "diff": { "functions": {...}, "migrations": {...}, "site_paths": {...} },
    "warnings": [...]
  }

  Errors map to structured envelopes with codes:
    PROMOTE_TARGET_NOT_FOUND        404 — release id doesn't exist
    PROMOTE_PROJECT_MISMATCH        400 — release belongs to another project
    PROMOTE_RELEASE_NOT_READY       409 — release status not promotable
    PROMOTE_NO_OP                   409 — target = current live (use
                                          cache.invalidateAll instead)
    PROMOTE_WARNING_REQUIRES_ACK    409 — at least one blocking warning
                                          unacked; details list codes`;

function parsePromoteArgs(args) {
  const opts = {
    releaseId: null,
    project: null,
    allowWarnings: false,
    allowWarningCodes: [],
    quiet: false,
  };
  const allowedFlags = [
    "--project",
    "--allow-warning",
    "--allow-warnings",
    "--quiet",
    "--final-only",
    "--help",
    "-h",
  ];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(PROMOTE_HELP);
      process.exit(0);
    }
    if (arg === "--project" || arg === "--allow-warning") {
      const value = args[i + 1];
      if (value === undefined || (typeof value === "string" && value.startsWith("--"))) {
        fail({
          code: "BAD_USAGE",
          message: `${arg} requires a value`,
          details: { flag: arg },
        });
      }
      if (arg === "--project") {
        opts.project = value;
      } else {
        opts.allowWarningCodes.push(value);
      }
      i += 1;
      continue;
    }
    if (arg === "--quiet" || arg === "--final-only") {
      opts.quiet = true;
      continue;
    }
    if (arg === "--allow-warnings") {
      opts.allowWarnings = true;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("-")) {
      fail({
        code: "BAD_USAGE",
        message: `Unknown flag for deploy promote: ${arg}`,
        details: { flag: arg, allowed_flags: allowedFlags },
      });
    }
    // Positional: the release id
    if (opts.releaseId !== null) {
      fail({
        code: "BAD_USAGE",
        message: `Unexpected positional argument for deploy promote: ${arg}`,
        details: { argument: arg, already_have: opts.releaseId },
      });
    }
    opts.releaseId = arg;
  }

  if (opts.releaseId === null) {
    fail({
      code: "BAD_USAGE",
      message: "deploy promote requires a release id (positional argument)",
      details: { example: "run402 deploy promote rel_abc123" },
    });
  }
  if (typeof opts.releaseId !== "string" || !opts.releaseId.startsWith("rel_")) {
    fail({
      code: "BAD_USAGE",
      message: `Invalid release id: '${opts.releaseId}' (expected rel_*)`,
      details: { release_id: opts.releaseId },
    });
  }

  return opts;
}

async function promoteCmd(args) {
  const opts = parsePromoteArgs(args);
  const projectId = opts.project ?? resolveProjectId(null);

  // Preserve the aggressive early-exit when no allowance is configured
  // — same as apply.
  allowanceAuthHeaders("/apply/v1/releases");

  try {
    // Call the engine directly (matches the pattern used by apply / resume
    // in this file). The `r.project(id).apply.promote` hero exists for
    // direct-SDK consumers; the CLI's `getSdk()` returns the unwrapped
    // Run402 instance whose `project()` method is async, so going through
    // the hero here would require an extra `await`.
    const result = await getSdk()._applyEngine.promote(projectId, opts.releaseId, {
      allowWarnings: opts.allowWarnings,
      allowWarningCodes: opts.allowWarningCodes,
    });
    if (!opts.quiet) {
      // Emit a single structured stderr event so observers can pick it up
      // alongside the regular deploy event stream. Promote is a one-shot
      // operation; there are no intermediate phase events.
      console.error(JSON.stringify({
        type: "promote.committed",
        release_id: result.release_id,
        previous_release_id: result.previous_release_id,
        operation_id: result.operation_id,
        warnings: result.warnings,
      }));
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

function hasStdinSource() {
  try {
    const stats = fstatSync(0);
    return stats.isFIFO() || stats.isFile();
  } catch {
    return false;
  }
}

function makeStderrEventWriter(quiet) {
  if (quiet) return undefined;
  return (event) => {
    console.error(JSON.stringify(event));
  };
}

function parseApplyArgs(args) {
  const opts = { manifest: null, spec: null, dir: null, project: null, quiet: false, allowWarnings: false, allowWarningCodes: [] };
  const allowedFlags = ["--manifest", "--spec", "--dir", "--project", "--quiet", "--final-only", "--allow-warning", "--allow-warnings", "--help", "-h"];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(APPLY_HELP);
      process.exit(0);
    }
    if (arg === "--manifest" || arg === "--spec" || arg === "--dir" || arg === "--project" || arg === "--allow-warning") {
      const value = args[i + 1];
      if (value === undefined || (typeof value === "string" && value.startsWith("--"))) {
        fail({
          code: "BAD_USAGE",
          message: `${arg} requires a value`,
          details: { flag: arg },
        });
      }
      if (arg === "--manifest") {
        if (opts.manifest !== null) {
          fail({
            code: "BAD_USAGE",
            message: "--manifest may only be provided once",
            details: { flag: "--manifest" },
          });
        }
        opts.manifest = value;
      } else if (arg === "--spec") {
        if (opts.spec !== null) {
          fail({
            code: "BAD_USAGE",
            message: "--spec may only be provided once",
            details: { flag: "--spec" },
          });
        }
        opts.spec = value;
      } else if (arg === "--dir") {
        if (opts.dir !== null) {
          fail({
            code: "BAD_USAGE",
            message: "--dir may only be provided once",
            details: { flag: "--dir" },
          });
        }
        opts.dir = value;
      } else if (arg === "--project") {
        opts.project = value;
      } else {
        opts.allowWarningCodes.push(value);
      }
      i += 1;
      continue;
    }
    if (arg === "--quiet" || arg === "--final-only") { opts.quiet = true; continue; }
    if (arg === "--allow-warnings") { opts.allowWarnings = true; continue; }
    if (typeof arg === "string" && arg.startsWith("-")) {
      fail({
        code: "BAD_USAGE",
        message: `Unknown flag for deploy apply: ${arg}`,
        details: { flag: arg, allowed_flags: allowedFlags },
      });
    }
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for deploy apply: ${arg}`,
      details: { argument: arg },
    });
  }

  return opts;
}

// Resolve the single manifest source from parsed opts + whether stdin actually
// has data (a pipe/file on fd 0). Explicit --manifest/--spec/--dir take
// precedence over incidental stdin: a CI runner (e.g. GitHub Actions) hands the
// step a FIFO/file stdin, which must NOT be mistaken for a piped manifest when a
// source flag is given. Exported for unit testing. Returns { source } | { error }.
export function resolveApplySource(opts, stdinPresent) {
  const explicit = [];
  if (opts.manifest !== null) explicit.push("--manifest");
  if (opts.spec !== null) explicit.push("--spec");
  if (explicit.length > 1) {
    return {
      error: {
        code: "BAD_USAGE",
        message: "Only one deploy manifest source may be provided: --manifest or --spec.",
        details: { sources: explicit },
      },
    };
  }
  if (opts.manifest !== null) return { source: "manifest" };
  if (opts.spec !== null) return { source: "spec" };
  if (opts.dir !== null) return { source: "dir" };
  if (stdinPresent) return { source: "stdin" };
  return {
    error: {
      code: "BAD_USAGE",
      message: "No deploy manifest provided. Use --manifest <path>, --spec '<json>', --dir <build>, or pipe a manifest on stdin.",
      details: {},
    },
  };
}

async function mergeAstroReleaseSlice(spec, dirArg) {
  let buildAstroReleaseSlice;
  try {
    ({ buildAstroReleaseSlice } = await import("@run402/astro/release-slice"));
  } catch (err) {
    fail({
      code: "BAD_USAGE",
      message:
        "--dir requires @run402/astro to be installed in this project. Add it as a dependency (e.g., `npm install -D @run402/astro`).",
      details: { flag: "--dir", import_error: err?.message ?? String(err) },
    });
  }

  const distDirAbs = isAbsolute(dirArg) ? dirArg : resolve(process.cwd(), dirArg);

  let slice;
  try {
    slice = await buildAstroReleaseSlice(distDirAbs);
  } catch (err) {
    if (err && typeof err === "object" && typeof err.code === "string" &&
      err.code.startsWith("R402_ASTRO_ADAPTER_MANIFEST_")) {
      fail({
        code: err.code,
        message: err.message,
        hint: err.suggestedFix,
        docs: err.docs,
        details: {
          flag: "--dir",
          dir: distDirAbs,
          file: err.file,
          ...(err.observedVersion ? { observed_version: err.observedVersion } : {}),
        },
      });
    }
    throw err;
  }

  // Slice owns site/functions. The caller's manifest can declare cross-cutting
  // slices (database, secrets, i18n, subdomains, routes) that the slice doesn't
  // touch. On collision in `functions.replace`, the slice wins for its own
  // function name; the caller's other functions are preserved. `site` is a
  // whole-resource replacement — slice wins entirely. The slice omits `routes`
  // by default (the SSR catchall is implicit; base routes carry forward), so we
  // only set `spec.routes` if the slice explicitly provides one; otherwise the
  // caller's manifest `routes` (if any) is preserved.
  spec.site = slice.site;
  if (slice.routes !== undefined) spec.routes = slice.routes;
  const sliceFns = slice.functions?.replace ?? {};
  const existingFns =
    spec.functions && typeof spec.functions === "object" && spec.functions.replace
      ? spec.functions.replace
      : {};
  spec.functions = { replace: { ...existingFns, ...sliceFns } };
}

/**
 * Derive the list of on-disk source files a raw manifest `spec` references,
 * resolved against `baseDir` (the manifest's directory, or cwd for
 * --spec/stdin). Walks the file-bearing slices:
 *   - functions.replace[name].source
 *   - functions.patch.put[name].source   (and functions.patch.set, an alias)
 *   - site.replace[key]                  (entry itself or entry.source)
 *   - site.patch.put[key]                (entry itself or entry.source)
 *
 * A manifest file entry is `{ path }` (on-disk ref) OR `{ data, encoding? }`
 * (inline bytes). Only `{ path }` entries with no `data` resolve to a disk
 * file; inline entries are skipped (nothing to scan on disk). Returns a
 * de-duped list of absolute paths. Existence + extension filtering is the
 * caller's job (GH-409). Defensive: tolerates missing/odd shapes silently —
 * the manifest normalizer is the authority on shape validity, not this
 * best-effort extractor.
 */
function isAstroSsrManifestFunction(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    Array.isArray(entry.capabilities) &&
    entry.capabilities.includes("astro.ssr.v1")
  );
}

export function collectManifestSourceFiles(spec, baseDir) {
  const out = new Set();
  if (!spec || typeof spec !== "object") return [];

  const resolveEntryPath = (entry) => {
    // The on-disk ref can be the entry itself (`{ path }`) or nested under
    // `.source` (function entries, asset put entries). Skip inline `{ data }`.
    const node =
      entry && typeof entry === "object" && entry.source && typeof entry.source === "object"
        ? entry.source
        : entry;
    if (
      node &&
      typeof node === "object" &&
      typeof node.path === "string" &&
      node.data === undefined
    ) {
      out.add(isAbsolute(node.path) ? node.path : resolve(baseDir, node.path));
    }
  };

  const eachValue = (map) => {
    if (!map || typeof map !== "object") return;
    for (const entry of Object.values(map)) resolveEntryPath(entry);
  };
  const eachFunctionValue = (map) => {
    if (!map || typeof map !== "object") return;
    for (const entry of Object.values(map)) {
      if (isAstroSsrManifestFunction(entry)) continue;
      resolveEntryPath(entry);
    }
  };

  const fns = spec.functions;
  if (fns && typeof fns === "object") {
    eachFunctionValue(fns.replace);
    if (fns.patch && typeof fns.patch === "object") {
      eachFunctionValue(fns.patch.put);
      eachFunctionValue(fns.patch.set);
    }
  }

  const site = spec.site;
  if (site && typeof site === "object") {
    eachValue(site.replace);
    if (site.patch && typeof site.patch === "object") {
      eachValue(site.patch.put);
    }
  }

  return [...out];
}

async function applyCmd(args) {
  const opts = parseApplyArgs(args);
  const { source, error: sourceError } = resolveApplySource(opts, hasStdinSource());
  if (sourceError) fail(sourceError);

  let raw;
  let manifestPath = null;
  if (source === "spec") {
    raw = opts.spec;
  } else if (source === "manifest") {
    try {
      manifestPath = isAbsolute(opts.manifest) ? opts.manifest : resolve(process.cwd(), opts.manifest);
      raw = readFileSync(manifestPath, "utf-8");
    } catch (err) {
      fail({
        code: "BAD_USAGE",
        message: `Failed to read manifest: ${err.message}`,
        details: { flag: "--manifest", path: opts.manifest },
      });
    }
  } else if (source === "dir") {
    // --dir without --manifest/--spec: start from an empty spec and let the
    // Astro release-slice fill in site/functions/routes below.
    raw = "{}";
  } else {
    // source === "stdin": a manifest piped on stdin.
    raw = await readStdin();
  }

  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (err) {
    fail({
      code: "BAD_USAGE",
      message: `Manifest is not valid JSON: ${err.message}`,
      details: { source, parse_error: err.message },
    });
  }
  rejectLegacySecretManifest(spec, {
    source,
    ...(manifestPath ? { path: manifestPath } : {}),
  });

  if (opts.dir !== null) {
    await mergeAstroReleaseSlice(spec, opts.dir);
  }

  // GH-232: Reject empty specs client-side. Without this guard,
  // `run402 deploy apply --spec '{}'` (and `--manifest <empty>`) would silently
  // send an empty ReleaseSpec to /apply/v1/plans with no signal that nothing
  // was deployed.
  //
  // `deploy apply` is v2-only — only meaningful keys are the v2 ReleaseSpec
  // shape (database, site, functions, secrets, subdomains, domains).
  // For object-typed sections the "container is non-empty" check isn't enough
  // — `site:{replace:{}}` has one key but ships nothing. We recurse one level
  // so any object whose own values are all empty containers is still empty.
  const meaningful = ["database", "site", "functions", "secrets", "subdomains", "routes", "checks", "i18n"];
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
  function hasDeployableSection(key, value) {
    if (key === "routes" && value && typeof value === "object" && !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, "replace") && Array.isArray(value.replace)) {
      return true;
    }
    // `i18n: null` clears the slice — that's a valid deploy on its own.
    if (key === "i18n" && value === null) return true;
    return hasContent(value);
  }
  const hasMeaningfulContent = spec && typeof spec === "object" && !Array.isArray(spec) &&
    meaningful.some((key) => hasDeployableSection(key, spec[key]));
  if (!hasMeaningfulContent) {
    fail({
      code: "MANIFEST_EMPTY",
      message: `Manifest contains no deployable sections. Expected at least one of: ${meaningful.join(", ")}`,
      hint: "Did you mean to write a 'site.replace' or 'database.migrations' block? See https://run402.com/schemas/manifest.v1.json",
      details: {
        field: source,
        ...(manifestPath ? { path: manifestPath } : {}),
        meaningful_keys: meaningful,
      },
    });
  }

  const manifestProject = spec.project ?? spec.project_id;
  if (opts.project && manifestProject && manifestProject !== opts.project) {
    fail({
      code: "BAD_USAGE",
      message: `project_id conflict: manifest project=${manifestProject} but --project=${opts.project}`,
      details: { spec_project_id: manifestProject, flag_project_id: opts.project },
    });
  }
  const useGithubActionsOidc = hasGithubActionsOidcEnv();
  let defaultProject;
  if (!opts.project && !manifestProject) {
    defaultProject = useGithubActionsOidc ? resolveCiProjectId() : resolveProjectId(null);
  }

  let normalizedManifest;
  try {
    normalizedManifest = await normalizeDeployManifest(spec, {
      baseDir: manifestPath ? dirname(manifestPath) : process.cwd(),
      ...(opts.project ? { project: opts.project } : {}),
      ...(defaultProject ? { defaultProject } : {}),
    });
  } catch (err) {
    reportSdkError(err);
  }

  const releaseSpec = normalizedManifest.spec;
  const idempotencyKey = normalizedManifest.idempotencyKey;

  // Pre-flight source scan (auth-aware-ssr Section 9). Bypass via
  // RUN402_DEPLOY_SKIP_SCAN=1 — useful for forcing a deploy when
  // the scanner has a false positive that the operator has confirmed
  // is fine. Hits with severity `error` fail the deploy.
  //
  // Scope (GH-409): a `--dir` (Astro SSR build) deploy walks that dir —
  // it IS the artifact. A manifest/spec/stdin deploy scans ONLY the
  // on-disk source files the manifest actually references, resolved
  // against the manifest's baseDir. We must NOT walk cwd/src for a
  // manifest deploy: running from inside an unrelated source tree (e.g.
  // the gateway monorepo, which legitimately has dozens of `getUser`
  // references) would otherwise block a deploy of one unrelated HTML file.
  if (process.env.RUN402_DEPLOY_SKIP_SCAN !== "1") {
    try {
      const { scanSourceTree, scanSourceFiles, SCAN_SEVERITY } = await import(
        "./doctor-source-scan.mjs"
      );
      const scannableExt = /\.(?:ts|tsx|js|jsx|mjs|cjs|astro)$/;
      let findings;
      if (opts.dir) {
        const scanRoot = isAbsolute(opts.dir)
          ? opts.dir
          : resolve(process.cwd(), opts.dir);
        findings = scanSourceTree(scanRoot, { cwd: process.cwd() });
      } else {
        const baseDir = manifestPath ? dirname(manifestPath) : process.cwd();
        const files = collectManifestSourceFiles(spec, baseDir).filter(
          (p) => scannableExt.test(p) && existsSync(p),
        );
        findings = files.length > 0
          ? scanSourceFiles(files, { cwd: process.cwd() })
          : [];
      }
      const errorFindings = findings.filter((f) => f.severity === SCAN_SEVERITY.ERROR);
      if (errorFindings.length > 0) {
        const summary = errorFindings.slice(0, 10).map((f) => {
          const loc = f.line ? `${f.file}:${f.line}` : f.file;
          return `  ${f.code} ${loc}\n    ${f.message}${f.canonical_name ? `\n    fix: ${f.canonical_name}` : ""}`;
        }).join("\n");
        const more = errorFindings.length > 10 ? `\n  ...and ${errorFindings.length - 10} more` : "";
        fail({
          code: "R402_AUTH_PREFLIGHT_FAILED",
          message: `Source scan blocked deploy: ${errorFindings.length} R402_AUTH_* finding(s). Run \`run402 doctor\` for the full list. Bypass with RUN402_DEPLOY_SKIP_SCAN=1 if you're sure.`,
          details: { findings: errorFindings, summary: `${summary}${more}` },
        });
      }
    } catch (err) {
      if (err && typeof err === "object" && err.code === "R402_AUTH_PREFLIGHT_FAILED") {
        throw err;
      }
      // Scanner crashed — warn but don't block. The scanner is a safety
      // net; the deploy should proceed if it can't read the source tree.
      console.warn(
        `[deploy] source scan skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let sdkOpts;
  if (useGithubActionsOidc) {
    sdkOpts = {
      credentials: githubActionsCredentials({ projectId: releaseSpec.project, apiBase: API }),
      disablePaidFetch: true,
    };
  } else if (!isCoreApiTarget() && !loadLiveControlPlaneSession()) {
    // Aggressive early exit when no allowance is configured — unless a
    // wallet-less human is deploying via their operator (control-plane) session
    // or the active target is a self-hosted Core Gateway.
    allowanceAuthHeaders("/apply/v1/plans");
  }

  try {
    const result = await withAutoApprove(() =>
      getSdk(sdkOpts)._applyEngine.apply(releaseSpec, {
        onEvent: makeStderrEventWriter(opts.quiet),
        idempotencyKey,
        allowWarnings: opts.allowWarnings,
        allowWarningCodes: opts.allowWarningCodes,
        target: isCoreApiTarget() ? "core" : "cloud",
      }),
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    reportDeployApplyError(err, useGithubActionsOidc);
  }
}

function hasGithubActionsOidcEnv(env = process.env) {
  return env.GITHUB_ACTIONS === "true" &&
    Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL) &&
    Boolean(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
}

function resolveCiProjectId(env = process.env) {
  const projectId = getActiveProjectId() || env.RUN402_PROJECT_ID;
  if (!projectId) {
    fail({
      code: "CI_PROJECT_REQUIRED",
      message: "GitHub Actions OIDC deploy requires a project id.",
      hint: "Pass --project <prj_...> in the workflow command, include project_id in the manifest, or set RUN402_PROJECT_ID.",
      details: { sources: ["--project", "manifest.project_id", "active_project", "RUN402_PROJECT_ID"] },
    });
  }
  return projectId;
}

const CI_DEPLOY_ERROR_GUIDANCE = {
  invalid_token: {
    hint: "Ensure the workflow has permissions: id-token: write and is running in the repository/branch linked with run402 ci link github.",
    next_actions: [
      nextAction("edit_request", { why: "Check the workflow permissions block includes id-token: write." }),
      editRequestAction("run402 ci link github", "Re-link if the repository, branch, or environment changed."),
    ],
  },
  access_denied: {
    hint: "The OIDC token was valid, but no active Run402 CI binding allowed this workflow.",
    next_actions: [
      editRequestAction("run402 ci list --project <prj_...>", "Inspect active CI bindings for this project."),
      editRequestAction("run402 ci link github", "Link this repository, branch, and environment to Run402."),
    ],
  },
  binding_revoked: {
    hint: "A matching CI binding existed but was revoked — most often because the project was transferred or handed to a new owner, which suspends the prior org's CI bindings.",
    next_actions: [
      editRequestAction("run402 ci link github", "Re-create the CI binding from this repository."),
      nextAction("edit_request", { why: "Do not run run402 ci set-asset-scopes; it returns 409 on a revoked binding." }),
      editRequestAction("run402 ci list --project <prj_...>", "Confirm the binding state locally."),
    ],
  },
  event_not_allowed: {
    hint: "This binding only allows push and workflow_dispatch events in v1.",
    next_actions: [
      nextAction("retry", { why: "Trigger the workflow with push or workflow_dispatch." }),
      nextAction("edit_request", { why: "Create a separate follow-up design before enabling PR deploy events." }),
    ],
  },
  repository_id_mismatch: {
    hint: "The GitHub repository id in the OIDC token does not match the linked binding.",
    next_actions: [
      editRequestAction("run402 ci link github", "Re-link from the current repository."),
      editRequestAction("run402 ci link github --repository-id <id>", "Pass the numeric GitHub repository id if automatic lookup fails."),
    ],
  },
  forbidden_spec_field: {
    hint: "CI deploys can deploy site/functions/database content and route declarations only when the binding includes covering route scopes.",
    next_actions: [
      nextAction("edit_request", { why: "Remove forbidden fields such as secrets, subdomains, or checks from the CI manifest." }),
      nextAction("edit_request", { why: "Keep the normalized manifest small enough to avoid manifest_ref." }),
    ],
  },
  CI_ROUTE_SCOPE_DENIED: {
    hint: "This CI binding does not cover one or more route declarations in the deploy manifest.",
    next_actions: [
      editRequestAction("run402 ci link github --route-scope <pattern>", "Add a CI route scope for every exact or prefix path the workflow may deploy."),
      nextAction("edit_request", { why: "Use exact scopes such as --route-scope /admin or prefix scopes such as --route-scope /api/*." }),
      editRequestAction("run402 deploy apply", "Run route changes locally when they are outside the CI delegation."),
    ],
  },
  forbidden_plan: {
    hint: "The gateway rejected this deploy plan for CI. Keep CI deploys to the allowed resources and re-link if policy changed.",
    next_actions: [
      nextAction("edit_request", { why: "Inspect the gateway error details for the rejected resource." }),
      editRequestAction("run402 deploy apply", "Run operations outside the CI allowlist locally."),
    ],
  },
  payment_required: {
    hint: "The project tier or payment state does not allow this CI deploy.",
    next_actions: [
      editRequestAction("run402 tier status --project <prj_...>", "Inspect project tier and payment state locally."),
      editRequestAction("run402 tier set <tier>", "Renew or upgrade the project tier, then re-run the workflow."),
    ],
  },
};

function reportDeployApplyError(err, useGithubActionsOidc) {
  const warningEnhanced = enhanceDeployWarningError(err);
  if (!useGithubActionsOidc) return reportSdkError(warningEnhanced);
  return reportSdkError(enhanceCiDeployError(warningEnhanced));
}

function enhanceDeployWarningError(err) {
  const existingBody = err?.body && typeof err.body === "object" && !Array.isArray(err.body)
    ? err.body
    : {};
  const warnings = Array.isArray(existingBody.warnings) ? existingBody.warnings : null;
  const code = existingBody.code || err?.code || null;
  const routeGuidance = routeWarningGuidance(warnings, code);
  if (!warnings && code !== "MISSING_REQUIRED_SECRET" && !routeGuidance) return err;

  const enhanced = Object.assign(new Error(err?.message || existingBody.message || String(code)), err);
  const affected = warnings
    ? warnings.flatMap((w) => Array.isArray(w?.affected) ? w.affected : [])
    : [];
  const unacknowledgedCodes = Array.isArray(existingBody.unacknowledged_warning_codes)
    ? existingBody.unacknowledged_warning_codes
    : warnings
      ? Array.from(new Set(warnings
        .filter((w) => w?.requires_confirmation || w?.code === "MISSING_REQUIRED_SECRET")
        .map((w) => w?.code)
        .filter(Boolean)))
      : code
        ? [code]
        : [];
  const allowWarningCommand = unacknowledgedCodes.length > 0
    ? `run402 deploy apply ${unacknowledgedCodes.map((warningCode) => `--allow-warning ${warningCode}`).join(" ")}`
    : "run402 deploy apply --allow-warning <code>";
  const allowWarningAction = editRequestAction(
    allowWarningCommand,
    unacknowledgedCodes.length > 0
      ? `Retry only after reviewing warning code${unacknowledgedCodes.length === 1 ? "" : "s"}: ${unacknowledgedCodes.join(", ")}.`
      : "Retry only after reviewing the warning code.",
  );
  const defaultNextActions = [
    ...(affected.length > 0
      ? [editRequestAction("run402 secrets set <project> <KEY> --stdin", `Set or inspect affected secrets: ${Array.from(new Set(affected)).join(", ")}`)]
      : []),
    retryAction("run402 deploy apply", "Retry after resolving warnings."),
    allowWarningAction,
    editRequestAction("run402 deploy apply --allow-warnings", "Use only when every warning was explicitly reviewed."),
  ];
  enhanced.body = {
    ...existingBody,
    code: code || "DEPLOY_WARNING_REQUIRES_CONFIRMATION",
    message: existingBody.message || err?.message || "Deploy plan returned warnings that require confirmation.",
    hint: existingBody.hint ||
      routeGuidance?.hint ||
      (code === "MISSING_REQUIRED_SECRET"
        ? "Set the missing secret values with `run402 secrets set <project> <KEY> --stdin` or `--file <path>`, then retry deploy apply."
        : "Review the plan warnings, then retry with --allow-warning <code> for reviewed warnings if you intentionally accept them."),
    next_actions: Array.isArray(existingBody.next_actions) && existingBody.next_actions.length > 0
      ? existingBody.next_actions
      : (routeGuidance?.next_actions ?? defaultNextActions),
    ...(warnings ? { warnings } : {}),
  };
  return enhanced;
}

const ROUTE_WARNING_GUIDANCE = {
  PUBLIC_ROUTED_FUNCTION: {
    hint: "A deploy route makes a function public same-origin browser ingress; direct /functions/v1/:name remains API-key protected.",
    next_actions: [
      nextAction("edit_request", { why: "Review application auth and authorization in the routed function." }),
      nextAction("edit_request", { why: "Add CSRF protection for cookie-authenticated POST/PUT/PATCH/DELETE routes." }),
      nextAction("edit_request", { why: "Implement CORS and OPTIONS explicitly when cross-origin callers are intended." }),
      retryAction("run402 deploy apply --allow-warnings", "Retry only after the public ingress review is intentional."),
    ],
  },
  ROUTE_TARGET_CARRIED_FORWARD: {
    hint: "A carried-forward route still points at a base-release function target.",
    next_actions: [
      editRequestAction("run402 deploy release active", "Inspect the active release."),
      editRequestAction("run402 deploy apply --manifest <path>", "Deploy routes.replace if the target should change in this release."),
    ],
  },
  ROUTE_SHADOWS_STATIC_PATH: {
    hint: "A dynamic route shadows a static site path.",
    next_actions: [
      nextAction("edit_request", { why: "Inspect the warning details for affected static paths." }),
      editRequestAction("run402 deploy release active", "Inspect live routes."),
      retryAction("run402 deploy apply --allow-warnings", "Retry only when dynamic shadowing is intentional."),
    ],
  },
  WILDCARD_ROUTE_SHADOWS_STATIC_PATHS: {
    hint: "A prefix wildcard route shadows one or more static site paths.",
    next_actions: [
      nextAction("edit_request", { why: "Review affected route/static path details." }),
      nextAction("edit_request", { why: "Split exact routes or move static paths if the shadowing is accidental." }),
      retryAction("run402 deploy apply --allow-warnings", "Retry only when the wildcard shadowing is intentional."),
    ],
  },
  METHOD_SPECIFIC_ROUTE_ALLOWS_GET_STATIC_FALLBACK: {
    hint: "A method-specific route allows static fallback for unmatched methods such as GET.",
    next_actions: [
      nextAction("edit_request", { why: "Confirm that static fallback for GET/HEAD is intended." }),
      nextAction("edit_request", { why: "Add method coverage or static files deliberately." }),
    ],
  },
  WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS: {
    hint: "A wildcard function route only allows GET/HEAD, so POST/PUT/PATCH/DELETE paths under that prefix will be rejected before the function runs.",
    next_actions: [
      nextAction("edit_request", { why: "Add the mutation methods the routed function supports, such as POST." }),
      nextAction("edit_request", { why: "Omit methods to allow every supported method when the route is an API surface." }),
      nextAction("edit_request", { why: "Set acknowledge_readonly: true on an intentionally read-only GET/HEAD wildcard function route." }),
      retryAction("run402 deploy apply --allow-warning WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS", "Use only as a reviewed CLI escape hatch."),
    ],
  },
  ROUTE_TABLE_NEAR_LIMIT: {
    hint: "The route table is near the gateway/project limit.",
    next_actions: [
      nextAction("edit_request", { why: "Consolidate prefix routes where possible." }),
      nextAction("edit_request", { why: "Remove stale route entries before adding more." }),
    ],
  },
  ROUTES_NOT_ENABLED: {
    hint: "Deploy-v2 web routes are not enabled for this project or environment; direct /functions/v1/:name remains protected and is not a browser-route substitute.",
    next_actions: [
      nextAction("edit_request", { why: "Deploy without the routes resource, or request route enablement for this project/environment." }),
      nextAction("edit_request", { why: "Keep direct function invocation API-key protected; do not substitute it for same-origin browser routes." }),
    ],
  },
  STATIC_ALIAS_SHADOWS_STATIC_PATH: {
    hint: "A static route target shadows a direct static path at the same public URL.",
    next_actions: [
      nextAction("edit_request", { why: "Inspect the route pattern, target.file, and direct static path." }),
      nextAction("edit_request", { why: "Confirm only when the static route target is intentional." }),
    ],
  },
  STATIC_ALIAS_RELATIVE_ASSET_RISK: {
    hint: "Relative asset URLs inside the target HTML may resolve differently at the static route target URL.",
    next_actions: [
      nextAction("edit_request", { why: "Inspect the target HTML for relative asset references." }),
      nextAction("edit_request", { why: "Use absolute asset URLs or confirm only when the alternate URL is intentional." }),
    ],
  },
  STATIC_ALIAS_DUPLICATE_CANONICAL_URL: {
    hint: "Both the static route target URL and the target file URL may be publicly reachable.",
    next_actions: [
      nextAction("edit_request", { why: "Decide which URL should be canonical." }),
      nextAction("edit_request", { why: "Update links/canonical tags or accept the duplicate public URL intentionally." }),
    ],
  },
  STATIC_ALIAS_EXTENSIONLESS_NON_HTML: {
    hint: "An extensionless static route target points at a non-HTML file.",
    next_actions: [
      nextAction("edit_request", { why: "Check that the extensionless route is meant to serve that content type." }),
      nextAction("edit_request", { why: "Prefer extensionless static route targets for HTML pages." }),
    ],
  },
  STATIC_ALIAS_TABLE_NEAR_LIMIT: {
    hint: "Static route targets count toward the route table limit.",
    next_actions: [
      nextAction("edit_request", { why: "Consolidate manual static route targets where possible." }),
      nextAction("edit_request", { why: "Avoid one route entry per page for large sites until framework-scale Web Output support exists." }),
    ],
  },
};

function routeWarningGuidance(warnings, code) {
  const routeCode = warnings
    ? warnings.map((w) => w?.code).find((warningCode) => ROUTE_WARNING_GUIDANCE[warningCode])
    : code && ROUTE_WARNING_GUIDANCE[code] ? code : null;
  return routeCode ? ROUTE_WARNING_GUIDANCE[routeCode] : null;
}

function enhanceCiDeployError(err) {
  const existingBody = err?.body && typeof err.body === "object" && !Array.isArray(err.body)
    ? err.body
    : {};
  const code = existingBody.code || err?.code || (err?.status === 402 ? "payment_required" : null);
  // Token-exchange denials (invalid_token, access_denied, binding_revoked, …)
  // carry their discriminator in the OAuth-style `error` field — the canonical
  // `code` collapses to the generic FORBIDDEN/INVALID_AUTH for all of them.
  // Plan-path denials (CI_ROUTE_SCOPE_DENIED, forbidden_spec_field, …) carry it
  // in `code` instead. Prefer whichever names a known guidance entry; the
  // OAuth `error` on plan-path errors is a human message, so it simply misses.
  const oauthError = typeof existingBody.error === "string" ? existingBody.error : null;
  const guidance =
    (oauthError && CI_DEPLOY_ERROR_GUIDANCE[oauthError]) ||
    (code && CI_DEPLOY_ERROR_GUIDANCE[code]) ||
    null;
  if (!guidance) return err;

  const enhanced = Object.assign(new Error(err?.message || existingBody.message || String(code)), err);
  enhanced.body = {
    ...existingBody,
    code,
    message: existingBody.message || err?.message || "GitHub Actions OIDC deploy failed.",
    hint: existingBody.hint || guidance.hint,
    next_actions: Array.isArray(existingBody.next_actions) && existingBody.next_actions.length > 0
      ? existingBody.next_actions
      : guidance.next_actions,
  };
  return enhanced;
}

function rejectLegacySecretManifest(spec, details) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return;
  const secrets = spec.secrets;
  if (secrets === undefined) return;
  if (Array.isArray(secrets) && secrets.length > 0) {
    fail({
      code: "UNSAFE_SECRET_MANIFEST",
      message: "Deploy manifests must not contain secret values. Legacy secrets arrays are no longer supported by deploy apply.",
      hint: "Run `run402 secrets set <project> <KEY> --file <path>` first, then use `\"secrets\": { \"require\": [\"KEY\"] }` in the deploy manifest.",
      details: { ...details, field: "secrets", legacy_shape: "array" },
    });
  }
  if (typeof secrets !== "object" || secrets === null) return;
  if (Object.prototype.hasOwnProperty.call(secrets, "set")) {
    fail({
      code: "UNSAFE_SECRET_MANIFEST",
      message: "Deploy manifests must not use secrets.set. Secret values are write-only and must be set outside deploy specs.",
      hint: "Run `run402 secrets set <project> <KEY> --file <path>` first, then use `\"secrets\": { \"require\": [\"KEY\"] }`.",
      details: { ...details, field: "secrets.set" },
    });
  }
  if (Object.prototype.hasOwnProperty.call(secrets, "replace_all")) {
    fail({
      code: "UNSAFE_SECRET_MANIFEST",
      message: "Deploy manifests must not use secrets.replace_all. Exact replacement is not representable in the value-free deploy contract.",
      hint: "Use `secrets.require` for keys that must exist and `secrets.delete` for explicit removals.",
      details: { ...details, field: "secrets.replace_all" },
    });
  }
}

async function resumeCmd(args) {
  const parsed = parseDeploySubcommandArgs(args, {
    command: "deploy resume",
    help: RESUME_HELP,
    booleanFlags: ["--quiet"],
  });
  const [operationId] = expectPositionals(parsed.positionals, {
    command: "run402 deploy resume <operation_id>",
    min: 1,
    max: 1,
    missing: "Missing <operation_id>.",
  });
  const opts = { operationId, quiet: Boolean(parsed.flags["--quiet"]) };

  allowanceAuthHeaders("/apply/v1/operations");

  try {
    const result = await getSdk()._applyEngine.resume(opts.operationId, {
      onEvent: makeStderrEventWriter(opts.quiet),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function listCmd(args) {
  const parsed = parseDeploySubcommandArgs(args, {
    command: "deploy list",
    help: LIST_HELP,
    valueFlags: ["--project", "--limit"],
  });
  expectPositionals(parsed.positionals, {
    command: "run402 deploy list [--project <id>] [--limit <n>]",
    max: 0,
  });
  const opts = {
    project: parsed.flags["--project"] ?? null,
    limit: parsed.flags["--limit"] === undefined ? null : parsePositiveInt(parsed.flags["--limit"], "--limit"),
  };

  const project = resolveProjectId(opts.project);
  allowanceAuthHeaders("/apply/v1/operations");

  try {
    const sdkOpts = { project };
    if (opts.limit !== null) sdkOpts.limit = opts.limit;
    const result = await getSdk()._applyEngine.list(sdkOpts);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function eventsCmd(args) {
  const parsed = parseDeploySubcommandArgs(args, {
    command: "deploy events",
    help: EVENTS_HELP,
    valueFlags: ["--project"],
  });
  const [operationId] = expectPositionals(parsed.positionals, {
    command: "run402 deploy events <operation_id>",
    min: 1,
    max: 1,
    missing: "Missing <operation_id>.",
  });
  const opts = { operationId, project: parsed.flags["--project"] ?? null };

  const project = resolveProjectId(opts.project);
  allowanceAuthHeaders("/apply/v1/operations");

  try {
    const result = await getSdk()._applyEngine.events(opts.operationId, { project });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function releaseCmd(args) {
  const action = args[0];
  if (!action || action === "--help" || action === "-h") {
    console.log(RELEASE_HELP);
    process.exit(0);
  }
  if (action === "get") return await releaseGetCmd(args.slice(1));
  if (action === "active") return await releaseActiveCmd(args.slice(1));
  if (action === "diff") return await releaseDiffCmd(args.slice(1));
  fail({
    code: "BAD_USAGE",
    message: `Unknown deploy release subcommand: ${action}`,
    details: { subcommand: action },
  });
}

async function releaseGetCmd(args) {
  const parsed = parseDeploySubcommandArgs(args, {
    command: "deploy release get",
    help: RELEASE_GET_HELP,
    valueFlags: ["--project", "--site-limit"],
  });
  const [releaseId] = expectPositionals(parsed.positionals, {
    command: "run402 deploy release get <release_id>",
    min: 1,
    max: 1,
    missing: "Missing <release_id>.",
  });
  const opts = {
    releaseId,
    project: parsed.flags["--project"] ?? null,
    siteLimit: parsed.flags["--site-limit"] === undefined
      ? null
      : parsePositiveInt(parsed.flags["--site-limit"], "--site-limit"),
  };

  const project = resolveProjectId(opts.project);

  try {
    const sdkOpts = { project, releaseId: opts.releaseId };
    if (opts.siteLimit !== null) sdkOpts.siteLimit = opts.siteLimit;
    const release = await getSdk()._applyEngine.getRelease(sdkOpts);
    console.log(JSON.stringify({ release }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function releaseActiveCmd(args) {
  const parsed = parseDeploySubcommandArgs(args, {
    command: "deploy release active",
    help: RELEASE_ACTIVE_HELP,
    valueFlags: ["--project", "--site-limit"],
  });
  expectPositionals(parsed.positionals, {
    command: "run402 deploy release active [--project <id>] [--site-limit <n>]",
    max: 0,
  });
  const opts = {
    project: parsed.flags["--project"] ?? null,
    siteLimit: parsed.flags["--site-limit"] === undefined
      ? null
      : parsePositiveInt(parsed.flags["--site-limit"], "--site-limit"),
  };

  const project = resolveProjectId(opts.project);

  try {
    const sdkOpts = { project };
    if (opts.siteLimit !== null) sdkOpts.siteLimit = opts.siteLimit;
    const release = await getSdk()._applyEngine.getActiveRelease(sdkOpts);
    console.log(JSON.stringify({ release }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function releaseDiffCmd(args) {
  const parsed = parseDeploySubcommandArgs(args, {
    command: "deploy release diff",
    help: RELEASE_DIFF_HELP,
    valueFlags: ["--project", "--from", "--to", "--limit"],
  });
  expectPositionals(parsed.positionals, {
    command: "run402 deploy release diff --from <target> --to <target>",
    max: 0,
  });
  const opts = {
    project: parsed.flags["--project"] ?? null,
    from: parsed.flags["--from"] ?? null,
    to: parsed.flags["--to"] ?? null,
    limit: parsed.flags["--limit"] === undefined ? null : parsePositiveInt(parsed.flags["--limit"], "--limit"),
  };
  if (!opts.from || !opts.to) {
    fail({
      code: "BAD_USAGE",
      message: "Missing --from or --to release target.",
      hint: "run402 deploy release diff --from empty --to active",
    });
  }
  if (opts.to === "empty") {
    fail({
      code: "BAD_USAGE",
      message: "--to cannot be empty. Use active or a release id.",
      details: { flag: "--to", value: opts.to },
    });
  }

  const project = resolveProjectId(opts.project);

  try {
    const sdkOpts = { project, from: opts.from, to: opts.to };
    if (opts.limit !== null) sdkOpts.limit = opts.limit;
    const diff = await getSdk()._applyEngine.diff(sdkOpts);
    console.log(JSON.stringify({ diff }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function diagnoseCmd(args) {
  const opts = { project: null, url: null, method: "GET" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") { console.log(DIAGNOSE_HELP); process.exit(0); }
    if (arg === "--project" && args[i + 1]) { opts.project = args[++i]; continue; }
    if (arg === "--method" && args[i + 1]) { opts.method = args[++i]; continue; }
    if (arg?.startsWith("--project=")) { opts.project = arg.slice("--project=".length); continue; }
    if (arg?.startsWith("--method=")) { opts.method = arg.slice("--method=".length); continue; }
    if (arg?.startsWith("-")) {
      fail({ code: "BAD_USAGE", message: `Unknown flag for deploy diagnose: ${arg}`, details: { flag: arg } });
    }
    if (!opts.url) {
      opts.url = arg;
      continue;
    }
    fail({
      code: "BAD_USAGE",
      message: "deploy diagnose accepts exactly one URL argument.",
      hint: "run402 deploy diagnose --project prj_... https://example.com/path --method GET",
    });
  }
  if (!opts.url) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <url>.",
      hint: "run402 deploy diagnose --project prj_... https://example.com/path --method GET",
    });
  }

  const project = resolveProjectId(opts.project);
  await printResolveEnvelope({ project, url: opts.url, method: opts.method });
}

async function resolveCmd(args) {
  const opts = { project: null, url: null, host: null, path: null, method: "GET" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") { console.log(RESOLVE_HELP); process.exit(0); }
    if (arg === "--project" && args[i + 1]) { opts.project = args[++i]; continue; }
    if (arg === "--url" && args[i + 1]) { opts.url = args[++i]; continue; }
    if (arg === "--host" && args[i + 1]) { opts.host = args[++i]; continue; }
    if (arg === "--path" && args[i + 1]) { opts.path = args[++i]; continue; }
    if (arg === "--method" && args[i + 1]) { opts.method = args[++i]; continue; }
    if (arg?.startsWith("--project=")) { opts.project = arg.slice("--project=".length); continue; }
    if (arg?.startsWith("--url=")) { opts.url = arg.slice("--url=".length); continue; }
    if (arg?.startsWith("--host=")) { opts.host = arg.slice("--host=".length); continue; }
    if (arg?.startsWith("--path=")) { opts.path = arg.slice("--path=".length); continue; }
    if (arg?.startsWith("--method=")) { opts.method = arg.slice("--method=".length); continue; }
    fail({ code: "BAD_USAGE", message: `Unknown argument for deploy resolve: ${arg}`, details: { argument: arg } });
  }

  if (opts.url && (opts.host || opts.path)) {
    fail({
      code: "BAD_USAGE",
      message: "Do not combine --url with --host or --path.",
      details: { url: Boolean(opts.url), host: Boolean(opts.host), path: Boolean(opts.path) },
    });
  }
  if (!opts.url && !opts.host) {
    fail({
      code: "BAD_USAGE",
      message: "Missing resolve input. Pass --url <url> or --host <host> [--path /x].",
      hint: "run402 deploy resolve --project prj_... --url https://example.com/",
    });
  }

  const project = resolveProjectId(opts.project);
  const input = opts.url
    ? { project, url: opts.url, method: opts.method }
    : {
        project,
        host: opts.host,
        ...(opts.path !== null ? { path: opts.path } : {}),
        method: opts.method,
      };
  await printResolveEnvelope(input);
}

async function printResolveEnvelope(input) {
  let request;
  try {
    request = normalizeDeployResolveRequest(input);
  } catch (err) {
    fail({
      code: "BAD_USAGE",
      message: err?.message || String(err),
      details: { input: redactResolveInput(input) },
    });
  }

  try {
    const resolution = await getSdk()._applyEngine.resolve(input);
    const summary = buildDeployResolveSummary(resolution, request);
    console.log(JSON.stringify({
      would_serve: summary.would_serve,
      diagnostic_status: summary.diagnostic_status,
      match: summary.match,
      summary: summary.summary,
      request,
      warnings: summary.warnings,
      resolution,
      next_steps: summary.next_steps,
    }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

function redactResolveInput(input) {
  const copy = { ...input };
  if (copy.url) {
    try {
      const url = new URL(copy.url);
      url.username = "";
      url.password = "";
      copy.url = url.toString();
    } catch {
      copy.url = String(copy.url).replace(/\/\/[^/@]+@/, "//<redacted>@");
    }
  }
  return copy;
}

function parseDeploySubcommandArgs(rawArgs, { command, help, valueFlags = [], booleanFlags = [] }) {
  const args = normalizeArgv(rawArgs);
  const valueFlagSet = new Set(valueFlags);
  const booleanFlagSet = new Set(booleanFlags);
  const numericFlagSet = new Set(["--limit", "--site-limit"]);
  const allowedFlags = new Set([...valueFlags, ...booleanFlags, "--help", "-h"]);
  const flags = {};
  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(help);
      process.exit(0);
    }
    if (valueFlagSet.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || (typeof value === "string" && value.startsWith("--"))) {
        if (numericFlagSet.has(arg)) parsePositiveInt(value, arg);
        fail({
          code: "BAD_USAGE",
          message: `${arg} requires a value`,
          details: { flag: arg },
        });
      }
      flags[arg] = value;
      i += 1;
      continue;
    }
    if (booleanFlagSet.has(arg)) {
      flags[arg] = true;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("-")) {
      fail({
        code: "BAD_USAGE",
        message: `Unknown flag for ${command}: ${arg}`,
        details: { flag: arg, allowed_flags: [...allowedFlags] },
      });
    }
    positionals.push(arg);
  }

  return { flags, positionals };
}

function expectPositionals(positionals, { command, min = 0, max = min, missing = "Missing required argument." }) {
  if (positionals.length < min) {
    fail({
      code: "BAD_USAGE",
      message: missing,
      hint: command,
    });
  }
  if (positionals.length > max) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for ${command}: ${positionals[max]}`,
      hint: `Use \`${command}\`.`,
    });
  }
  return positionals;
}

function parsePositiveInt(value, flag) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    fail({
      code: "BAD_USAGE",
      message: `${flag} must be a positive integer.`,
      details: { flag, value },
    });
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail({
      code: "BAD_USAGE",
      message: `${flag} must be a positive integer.`,
      details: { flag, value },
    });
  }
  return parsed;
}
