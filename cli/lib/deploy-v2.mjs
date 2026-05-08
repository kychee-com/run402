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
 *     "secrets":   { "require": ["OPENAI_API_KEY"], "delete": ["OLD_KEY"] },
 *     "functions": { "replace": {...}, "patch": { "set": {...}, "delete": [...] } },
 *     "site":      { "replace": {...} } | { "patch": { "put": {...}, "delete": [...] } },
 *     "subdomains": { "set": ["..."], "add": [...], "remove": [...] },
 *     "routes": { "replace": [{ "pattern": "/api/*", "methods": ["GET", "POST"], "target": { "type": "function", "name": "api" } }] },
 *     "idempotency_key": "..."
 *   }
 *
 * File entries: `{ "data": "...", "encoding": "utf-8" | "base64", "contentType": "..." }`
 * — same shape used by `bundle_deploy`. UTF-8 is the default; binary files
 * pass `"encoding": "base64"`.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { githubActionsCredentials, normalizeDeployManifest } from "#sdk/node";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { API, allowanceAuthHeaders, getActiveProjectId, resolveProjectId } from "./config.mjs";

const APPLY_HELP = `run402 deploy apply — Unified deploy primitive (v1.34+)

Usage:
  run402 deploy apply --manifest <path> [--project <id>] [--quiet] [--allow-warnings]
  run402 deploy apply --spec '<json>' [--project <id>] [--quiet] [--allow-warnings]
  cat spec.json | run402 deploy apply [--project <id>]

Manifest format mirrors the MCP \`deploy\` tool's ReleaseSpec:
  {
    "project_id": "prj_...",
    "base": { "release": "current" },
    "database": { "migrations": [{ "id": "001_init", "sql": "CREATE TABLE ..." }], "expose": {...} },
    "secrets":   { "require": ["OPENAI_API_KEY"], "delete": ["OLD_KEY"] },
    "functions": { "replace": { "api": { "source": { "data": "export default ..." } } } },
    "site":      { "replace": { "index.html": { "data": "<html>..." } } },
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
          "source": { "data": "import { routedHttp } from '@run402/functions'; export default async (event) => routedHttp.json({ ok: true, path: event.path });" }
        }
      }
    },
    "routes": { "replace": [{ "pattern": "/api/*", "target": { "type": "function", "name": "api" } }] }
  }

Options:
  --manifest <path>       Read the spec from this JSON file
  --spec '<json>'         Inline JSON spec (single-quote in shell)
  --project <id>          Override project_id from the manifest
  --quiet                 Suppress per-event JSON-line stderr (final result still on stdout)
  --allow-warnings        Continue past plan warnings that require confirmation

Output:
  stdout: { "status": "ok", "release_id": "rel_...", "operation_id": "op_...", "urls": {...}, "warnings": [...] }
  stderr: one JSON event per line (suppressed with --quiet)

Secrets:
  Secret values do not belong in deploy manifests. Set them first:
    run402 secrets set prj_... OPENAI_API_KEY --file ./.secrets/openai-key
  Then deploy a value-free declaration:
    { "project_id": "prj_...", "secrets": { "require": ["OPENAI_API_KEY"] } }

Patch examples (only the listed file changes):
  { "project_id": "prj_...", "site": { "patch": { "put": { "index.html": { "data": "..." } } } } }
  { "project_id": "prj_...", "site": { "patch": { "delete": ["old.html"] } } }

Routes:
  Omit routes or pass "routes": null to carry forward base routes.
  Use "routes": { "replace": [] } to clear dynamic routes.
  Routes activate atomically with the release. Direct /functions/v1/:name remains API-key protected.
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
  get/active: { "status": "ok", "release": {...} }  # includes route inventory and inventory warnings when returned
  diff:       { "status": "ok", "diff": {...} }     # includes route added/removed/changed diff buckets
`;

const RELEASE_GET_HELP = `run402 deploy release get — Fetch a release inventory by id

Usage:
  run402 deploy release get <release_id> [--project <id>] [--site-limit <n>]

Options:
  --project <id>          Project ID that owns the release (default: active project)
  --site-limit <n>        Maximum site path entries to include (gateway default: 5000)

Output:
  stdout: { "status": "ok", "release": {...} }  # preserves full routes inventory and warnings
`;

const RELEASE_ACTIVE_HELP = `run402 deploy release active — Fetch the active release inventory

Usage:
  run402 deploy release active [--project <id>] [--site-limit <n>]

Options:
  --project <id>          Project ID to inspect (default: active project)
  --site-limit <n>        Maximum site path entries to include (gateway default: 5000)

Output:
  stdout: { "status": "ok", "release": {...} }  # preserves full routes inventory and warnings
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
  stdout: { "status": "ok", "diff": {...} }  # preserves routes.added/removed/changed
`;

export async function runDeployV2(sub, args) {
  if (sub === "apply") return await applyCmd(args);
  if (sub === "resume") return await resumeCmd(args);
  if (sub === "list") return await listCmd(args);
  if (sub === "events") return await eventsCmd(args);
  if (sub === "release") return await releaseCmd(args);
  fail({
    code: "BAD_USAGE",
    message: `Unknown deploy subcommand: ${sub}`,
    details: { subcommand: sub },
  });
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
  const opts = { manifest: null, spec: null, project: null, quiet: false, allowWarnings: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(APPLY_HELP); process.exit(0); }
    if (args[i] === "--manifest" && args[i + 1]) { opts.manifest = args[++i]; continue; }
    if (args[i] === "--spec" && args[i + 1]) { opts.spec = args[++i]; continue; }
    if (args[i] === "--project" && args[i + 1]) { opts.project = args[++i]; continue; }
    if (args[i] === "--quiet") { opts.quiet = true; continue; }
    if (args[i] === "--allow-warnings") { opts.allowWarnings = true; continue; }
  }

  let raw;
  let manifestPath = null;
  if (opts.spec) {
    raw = opts.spec;
  } else if (opts.manifest) {
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
  } else {
    raw = await readStdin();
  }

  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (err) {
    fail({
      code: "BAD_USAGE",
      message: `Manifest is not valid JSON: ${err.message}`,
      details: { source: opts.manifest ? "manifest" : opts.spec ? "spec" : "stdin", parse_error: err.message },
    });
  }
  rejectLegacySecretManifest(spec, {
    source: opts.manifest ? "manifest" : opts.spec ? "spec" : "stdin",
    ...(manifestPath ? { path: manifestPath } : {}),
  });

  // GH-232: Reject empty specs client-side. Without this guard,
  // `run402 deploy apply --spec '{}'` (and `--manifest <empty>`) would silently
  // send an empty ReleaseSpec to /deploy/v2/plans with no signal that nothing
  // was deployed. This mirrors the GH-185 guard already in place for the
  // legacy `run402 deploy --manifest` path.
  //
  // `deploy apply` is v2-only — only meaningful keys are the v2 ReleaseSpec
  // shape (database, site, functions, secrets, subdomains, domains).
  // For object-typed sections the "container is non-empty" check isn't enough
  // — `site:{replace:{}}` has one key but ships nothing. We recurse one level
  // so any object whose own values are all empty containers is still empty.
  const meaningful = ["database", "site", "functions", "secrets", "subdomains", "routes", "checks"];
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
        field: opts.manifest ? "manifest" : opts.spec ? "spec" : "stdin",
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

  let sdkOpts;
  if (useGithubActionsOidc) {
    sdkOpts = {
      credentials: githubActionsCredentials({ projectId: releaseSpec.project, apiBase: API }),
      disablePaidFetch: true,
    };
  } else {
    // Preserve the aggressive early exit when no allowance is configured.
    allowanceAuthHeaders("/deploy/v2/plans");
  }

  try {
    const result = await getSdk(sdkOpts).deploy.apply(releaseSpec, {
      onEvent: makeStderrEventWriter(opts.quiet),
      idempotencyKey,
      allowWarnings: opts.allowWarnings,
    });
    console.log(JSON.stringify({ status: "ok", ...result }, null, 2));
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
      "Check the workflow permissions block includes id-token: write.",
      "Re-run run402 ci link github if the repository, branch, or environment changed.",
    ],
  },
  access_denied: {
    hint: "The OIDC token was valid, but no active Run402 CI binding allowed this workflow.",
    next_actions: [
      "Run run402 ci list --project <prj_...> locally to inspect bindings.",
      "Run run402 ci link github again for this repository/branch/environment.",
    ],
  },
  event_not_allowed: {
    hint: "This binding only allows push and workflow_dispatch events in v1.",
    next_actions: [
      "Trigger the workflow with push or workflow_dispatch.",
      "Create a separate follow-up design before enabling PR deploy events.",
    ],
  },
  repository_id_mismatch: {
    hint: "The GitHub repository id in the OIDC token does not match the linked binding.",
    next_actions: [
      "Run run402 ci link github again from the current repository.",
      "If automatic lookup fails, pass --repository-id with the numeric GitHub repository id.",
    ],
  },
  forbidden_spec_field: {
    hint: "CI deploys can deploy site/functions/database content and route declarations only when the binding includes covering route scopes.",
    next_actions: [
      "Remove forbidden fields such as secrets, subdomains, or checks from the CI manifest.",
      "Keep the normalized manifest small enough to avoid manifest_ref.",
    ],
  },
  CI_ROUTE_SCOPE_DENIED: {
    hint: "This CI binding does not cover one or more route declarations in the deploy manifest.",
    next_actions: [
      "Re-run run402 ci link github with --route-scope for every exact or prefix path the workflow may deploy.",
      "Use exact scopes such as --route-scope /admin or prefix scopes such as --route-scope /api/*.",
      "Run the deploy locally with run402 deploy apply for route changes outside the CI delegation.",
    ],
  },
  forbidden_plan: {
    hint: "The gateway rejected this deploy plan for CI. Keep CI deploys to the allowed resources and re-link if policy changed.",
    next_actions: [
      "Inspect the gateway error details for the rejected resource.",
      "Run the deploy locally with run402 deploy apply for operations outside the CI allowlist.",
    ],
  },
  payment_required: {
    hint: "The project tier or payment state does not allow this CI deploy.",
    next_actions: [
      "Run run402 tier status --project <prj_...> locally.",
      "Renew or upgrade the project tier, then re-run the workflow.",
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
  const defaultNextActions = [
    ...(affected.length > 0
      ? [`Set or inspect affected secrets: ${Array.from(new Set(affected)).join(", ")}`]
      : []),
    "Retry `run402 deploy apply` after resolving warnings.",
    "Use `--allow-warnings` only when the warning was explicitly reviewed.",
  ];
  enhanced.body = {
    ...existingBody,
    code: code || "DEPLOY_WARNING_REQUIRES_CONFIRMATION",
    message: existingBody.message || err?.message || "Deploy plan returned warnings that require confirmation.",
    hint: existingBody.hint ||
      routeGuidance?.hint ||
      (code === "MISSING_REQUIRED_SECRET"
        ? "Set the missing secret values with `run402 secrets set`, then retry deploy apply. Use --allow-warnings only after explicit review."
        : "Review the plan warnings, then retry with --allow-warnings if you intentionally accept them."),
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
      "Review application auth and authorization in the routed function.",
      "Add CSRF protection for cookie-authenticated POST/PUT/PATCH/DELETE routes.",
      "Implement CORS and OPTIONS explicitly when cross-origin callers are intended.",
      "Retry with --allow-warnings only after the public ingress review is intentional.",
    ],
  },
  ROUTE_TARGET_CARRIED_FORWARD: {
    hint: "A carried-forward route still points at a base-release function target.",
    next_actions: [
      "Inspect the active release with run402 deploy release active.",
      "Deploy routes.replace if the target should change in this release.",
    ],
  },
  ROUTE_SHADOWS_STATIC_PATH: {
    hint: "A dynamic route shadows a static site path.",
    next_actions: [
      "Inspect the warning details for affected static paths.",
      "Inspect live routes with run402 deploy release active.",
      "Retry with --allow-warnings only when dynamic shadowing is intentional.",
    ],
  },
  WILDCARD_ROUTE_SHADOWS_STATIC_PATHS: {
    hint: "A prefix wildcard route shadows one or more static site paths.",
    next_actions: [
      "Review affected route/static path details.",
      "Split exact routes or move static paths if the shadowing is accidental.",
      "Retry with --allow-warnings only when the wildcard shadowing is intentional.",
    ],
  },
  METHOD_SPECIFIC_ROUTE_ALLOWS_GET_STATIC_FALLBACK: {
    hint: "A method-specific route allows static fallback for unmatched methods such as GET.",
    next_actions: [
      "Confirm that static fallback for GET/HEAD is intended.",
      "Add method coverage or static files deliberately.",
    ],
  },
  ROUTE_TABLE_NEAR_LIMIT: {
    hint: "The route table is near the gateway/project limit.",
    next_actions: [
      "Consolidate prefix routes where possible.",
      "Remove stale route entries before adding more.",
    ],
  },
  ROUTES_NOT_ENABLED: {
    hint: "Deploy-v2 web routes are not enabled for this project or environment; direct /functions/v1/:name remains protected and is not a browser-route substitute.",
    next_actions: [
      "Deploy without the routes resource, or request route enablement for this project/environment.",
      "Keep direct function invocation API-key protected; do not substitute it for same-origin browser routes.",
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
  const guidance = code ? CI_DEPLOY_ERROR_GUIDANCE[code] : null;
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
  const opts = { operationId: null, quiet: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(RESUME_HELP); process.exit(0); }
    if (args[i] === "--quiet") { opts.quiet = true; continue; }
    if (!args[i].startsWith("-") && !opts.operationId) opts.operationId = args[i];
  }
  if (!opts.operationId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <operation_id>.",
      hint: "run402 deploy resume <operation_id>",
    });
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
    fail({
      code: "BAD_USAGE",
      message: "Missing <operation_id>.",
      hint: "run402 deploy events <operation_id>",
    });
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
  const opts = { releaseId: null, project: null, siteLimit: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(RELEASE_GET_HELP); process.exit(0); }
    if (args[i] === "--project" && args[i + 1]) { opts.project = args[++i]; continue; }
    if (args[i] === "--site-limit" && args[i + 1]) { opts.siteLimit = parsePositiveInt(args[++i], "--site-limit"); continue; }
    if (!args[i].startsWith("-") && !opts.releaseId) opts.releaseId = args[i];
  }
  if (!opts.releaseId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <release_id>.",
      hint: "run402 deploy release get <release_id>",
    });
  }

  const project = resolveProjectId(opts.project);

  try {
    const sdkOpts = { project };
    if (opts.siteLimit !== null) sdkOpts.siteLimit = opts.siteLimit;
    const release = await getSdk().deploy.getRelease(opts.releaseId, sdkOpts);
    console.log(JSON.stringify({ status: "ok", release }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function releaseActiveCmd(args) {
  const opts = { project: null, siteLimit: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(RELEASE_ACTIVE_HELP); process.exit(0); }
    if (args[i] === "--project" && args[i + 1]) { opts.project = args[++i]; continue; }
    if (args[i] === "--site-limit" && args[i + 1]) { opts.siteLimit = parsePositiveInt(args[++i], "--site-limit"); continue; }
  }

  const project = resolveProjectId(opts.project);

  try {
    const sdkOpts = { project };
    if (opts.siteLimit !== null) sdkOpts.siteLimit = opts.siteLimit;
    const release = await getSdk().deploy.getActiveRelease(sdkOpts);
    console.log(JSON.stringify({ status: "ok", release }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function releaseDiffCmd(args) {
  const opts = { project: null, from: null, to: null, limit: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(RELEASE_DIFF_HELP); process.exit(0); }
    if (args[i] === "--project" && args[i + 1]) { opts.project = args[++i]; continue; }
    if (args[i] === "--from" && args[i + 1]) { opts.from = args[++i]; continue; }
    if (args[i] === "--to" && args[i + 1]) { opts.to = args[++i]; continue; }
    if (args[i] === "--limit" && args[i + 1]) { opts.limit = parsePositiveInt(args[++i], "--limit"); continue; }
  }
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
    const diff = await getSdk().deploy.diff(sdkOpts);
    console.log(JSON.stringify({ status: "ok", diff }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

function parsePositiveInt(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail({
      code: "BAD_USAGE",
      message: `${flag} must be a positive integer.`,
      details: { flag, value },
    });
  }
  return parsed;
}
