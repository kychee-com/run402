import { readFileSync } from "fs";
import { loadKeyStore, API, allowanceAuthHeaders, resolveProjectId, getActiveProjectId, isCoreApiTarget } from "./config.mjs";
import { loadLiveOperatorSession } from "../core-dist/operator-session.js";
import { loadLiveControlPlaneSession } from "../core-dist/control-plane-session.js";
import { withAutoApprove } from "./operator.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail, parseFlagJson } from "./sdk-errors.mjs";
import { assertKnownFlags, failBadProjectId, flagValue, hasHelp, normalizeArgv, positionalArgs, resolvePositionalProject, validateRegularFile } from "./argparse.mjs";

const HELP = `run402 projects — Manage your deployed Run402 projects

Usage:
  run402 projects <subcommand> [args...]

Subcommands:
  quote                                   Show pricing tiers
  provision [--tier <tier>] [--name <n>] [--org <id>]  Provision a new Postgres project
  use   <id>                              Set the active project (used as default for other commands)
  list [--org <id>] [--all]               List your projects from the server (name, site_url, custom domains, org_id, active marker)
  rename <id> --name <label>              Rename a project (fix an auto-generated name)
  get   [id]                              Authoritative server read: status, org, tier, active deploy, mailbox, usage vs limits (live; no keys)
  info  [id]                              Show local project details: REST URL, keys (local keystore only)
  keys  [id]                              Print anon_key and service_key as JSON (local keystore only)
  sql   [id] "<query>" [--file <path>] [--params '<json>']  Run a SQL query (supports parameterized queries)
  rest  [id] <table> [params]             Query a table via the REST API (PostgREST)
  usage [id]                              Show compute/storage usage for a project
  costs [id] [--window <w>]               Show admin-only per-project revenue/cost/margin
  schema [id]                             Inspect the database schema
  apply-expose [id] <manifest_json>       Apply a declarative authorization manifest
  apply-expose [id] --file <path>         Apply a manifest from a JSON file
  validate-expose [id] <manifest_json>    Validate an authorization manifest without applying it
  validate-expose [id] --file <path>      Validate a manifest file without mutating the project
  get-expose   [id]                       Get the current authorization manifest
  delete [id] --confirm                   Immediately and irreversibly delete a project (cascade purge) and remove from local state. Requires --confirm.
  promote-user [id] <email>               Promote a user to project_admin role
  demote-user  [id] <email>               Demote a user from project_admin role

Examples:
  run402 projects quote
  run402 projects provision --tier prototype
  run402 projects provision --tier hobby --name my-app
  run402 projects use prj_abc123
  run402 projects list
  run402 projects list --org 11111111-2222-3333-4444-555555555555
  run402 projects list --all
  run402 projects rename prj_abc123 --name "My Site"
  run402 projects get prj_abc123
  run402 projects info prj_abc123
  run402 projects sql prj_abc123 "SELECT * FROM users LIMIT 5"
  run402 projects sql prj_abc123 "SELECT * FROM users WHERE id = $1" --params '[42]'
  run402 projects sql prj_abc123 --file setup.sql
  run402 projects rest prj_abc123 users "limit=10&select=id,name"
  run402 projects usage prj_abc123
  run402 projects costs prj_abc123 --window 30d
  run402 projects schema prj_abc123
  run402 projects validate-expose prj_abc123 --file manifest.json
  run402 projects apply-expose prj_abc123 --file manifest.json
  run402 projects get-expose prj_abc123
  run402 projects keys prj_abc123
  run402 projects delete prj_abc123 --confirm

Global options (any command):
  --wallet <name>   Use a named wallet (profile) for this command. Precedence:
                    --wallet > RUN402_WALLET env > nearest .run402.json binding >
                    'run402 wallets use' default > 'default'. See 'run402 wallets'.

Notes:
  - <id> is the project_id shown in 'run402 projects list' (prefix: 'prj_')
  - Most commands that take <id> default to the active project when omitted
    (set it with 'run402 projects use <id>'). Project IDs start with 'prj_';
    any first positional that doesn't is treated as the next argument instead.
  - 'list' is a SERVER read, not the local keystore: it shows every project the
    active wallet can reach (membership-scoped), with name, site_url, custom
    domains, and org_id. '--org <id>' filters to one org; '--all' reads the
    cross-wallet inventory for every wallet controlling your operator email
    (run 'run402 operator login' first for the union, else it falls back to the
    current wallet's slice). The 'active' marker still comes from local state.
  - 'rename' fixes a project's display name. You must be an org admin (or hold a
    project:write grant) on the owning org; it works even if the project was
    never provisioned from this machine.
  - 'rest' uses PostgREST query syntax (table name + optional query string)
  - 'provision' requires a funded allowance on Run402 Cloud. Against a
    configured Run402 Core target, it creates a local Core project without
    payment.
  - 'apply-expose' declares the full authorization surface (tables, views, RPCs)
    in one convergent call. Tables not listed with expose:true are dark by
    default. Schema: https://run402.com/schemas/manifest.v1.json. Sample:
      {"version":"1",
       "tables":[{"name":"posts","expose":true,"policy":"user_owns_rows","owner_column":"user_id","force_owner_on_insert":true}],
       "views":[],
       "rpcs":[]}
    Per-table policies: user_owns_rows (requires owner_column;
    force_owner_on_insert sets it from auth.uid() automatically),
    public_read_authenticated_write (anyone reads, any auth'd user writes any
    row), public_read_write_UNRESTRICTED (fully open; requires
    "i_understand_this_is_unrestricted": true on the entry), custom (provide
    custom_sql with CREATE POLICY statements).
  - 'validate-expose' checks the same auth/expose manifest shape without
    applying it. Optional migration SQL is used only for reference checks; it is
    not executed as a PostgreSQL dry run.
`;

const SUB_HELP = {
  list: `run402 projects list — List your projects from the server

Usage:
  run402 projects list [--org <id>] [--all]

Options:
  --org <id>          Filter to projects owned by one org (organization).
                      Authorize-before-reveal: a non-member or guessed id is a
                      403; a non-UUID id is a 400.
  --all               Read the cross-wallet inventory across every wallet
                      controlling your operator email. Run 'run402 operator
                      login' first for the union; without a session it falls
                      back to the current wallet's slice. Mutually exclusive
                      with --org.

Notes:
  - This is a SERVER read (membership-scoped), not the local keystore. Each row
    has project_id, name, site_url, custom_domains, org_id, status, and an
    'active' marker derived from local state.
  - Tier and lifecycle live on the organization, not each project — use
    'run402 status' or 'run402 tier status' for the account view.

Examples:
  run402 projects list
  run402 projects list --org 11111111-2222-3333-4444-555555555555
  run402 projects list --all
  run402 projects list --wallet work
`,
  rename: `run402 projects rename — Rename a project

Usage:
  run402 projects rename <id> --name <label>

Arguments:
  <id>                Project ID (prefix: 'prj_'). Required.

Options:
  --name <label>      New display name (1-200 chars, no control characters).

Notes:
  - You must be an org admin (or hold a project:write grant) on the owning org.
    Authorize-before-reveal: an unauthorized or guessed id returns 403, never a
    not-found oracle. Works even if the project isn't in the local keystore.

Examples:
  run402 projects rename prj_abc123 --name "My Site"
`,
  provision: `run402 projects provision — Provision a new Postgres project

Usage:
  run402 projects provision [--tier <tier>] [--name <name>] [--org <id>] [--idempotency-key <key>]

Options:
  --tier <tier>       Tier for the new project (default: prototype)
  --name <name>       Human-readable name for the project
  --org <id>          Provision into an EXISTING org (needs developer+ on it).
                      Omit for the cold-start path. Tier is org-governed.
  --idempotency-key <key>  Retry-safe key: re-running with the same key returns
                      the existing project instead of duplicating it. Auto-derived
                      from --name when omitted; an unnamed provision stays un-keyed.

Notes:
  - Payment is automatic via x402 on Run402 Cloud; requires a funded allowance.
    Against a configured Run402 Core target, no Cloud tier/allowance/payment is
    required.
  - The new project becomes the active project after provisioning

Examples:
  run402 projects provision
  run402 projects provision --tier prototype
  run402 projects provision --tier hobby --name my-app
  run402 projects provision --org org_abc123
`,
  sql: `run402 projects sql — Run a SQL query against a project's database

Usage:
  run402 projects sql [id] "<query>" [options]
  run402 projects sql [id] --file <path> [options]

Arguments:
  [id]                Project ID (defaults to the active project if omitted;
                      must start with 'prj_' — any other first arg is treated
                      as the query instead)
  <query>             Inline SQL query (quote it to preserve spaces)

Options:
  --file <path>       Read SQL from a file instead of an inline query
  --params '<json>'   JSON array of parameters for a parameterized query

Examples:
  run402 projects sql prj_abc123 "SELECT * FROM users LIMIT 5"
  run402 projects sql prj_abc123 "SELECT * FROM users WHERE id = $1" --params '[42]'
  run402 projects sql prj_abc123 --file setup.sql
`,
  costs: `run402 projects costs — Show admin-only per-project finance

Usage:
  run402 projects costs [id] [--window <24h|7d|30d|90d>]

Arguments:
  [id]                Project ID (defaults to the active project if omitted)

Options:
  --window <w>        Finance window (default: 30d). One of: 24h, 7d, 30d, 90d

Environment:
  RUN402_ADMIN_COOKIE Optional admin OAuth cookie header, e.g. "run402_admin=..."

Notes:
  - Platform-admin only. The configured allowance wallet must be an admin
    wallet, or RUN402_ADMIN_COOKIE must contain an admin OAuth cookie.
  - Project service keys are not enough for this endpoint.
  - Output is the gateway's per-project finance JSON: revenue, direct cost,
    direct margin, and direct_cost_breakdown rows.

Examples:
  run402 projects costs prj_abc123
  RUN402_ADMIN_COOKIE='run402_admin=...' run402 projects costs prj_abc123
  RUN402_ADMIN_COOKIE='run402_admin=...' run402 projects costs --window 7d
`,
  "validate-expose": `run402 projects validate-expose — Validate an authorization manifest without applying it

Usage:
  run402 projects validate-expose [id] <manifest_json> [options]
  run402 projects validate-expose [id] --file <path> [options]
  cat manifest.json | run402 projects validate-expose [id] [options]

Arguments:
  [id]                Optional project ID. When omitted, the active project is
                      used if one is set; otherwise validation is projectless.
  <manifest_json>     Inline auth/expose manifest JSON.

Options:
  --file <path>            Read the auth/expose manifest from a JSON file
  --migration-file <path>  Read migration SQL for reference checks only
  --migration-sql <sql>    Inline migration SQL for reference checks only

Notes:
  - This validates the auth/expose manifest used by manifest.json,
    database.expose, and apply-expose. It does not validate deploy manifests.
  - Migration SQL is parsed as context for references; it is not executed.
  - Validation findings are returned in JSON with hasErrors and do not make the
    command fail. Usage, file, auth, and network errors still exit non-zero.

Examples:
  run402 projects validate-expose --file manifest.json
  run402 projects validate-expose prj_abc123 --file manifest.json --migration-file setup.sql
  run402 projects validate-expose '{"version":"1","tables":[]}'
`,
};

const FINANCE_WINDOWS = new Set(["24h", "7d", "30d", "90d"]);

async function quote() {
  try {
    const data = await getSdk().projects.getQuote();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function provision(args) {
  const opts = { tier: "prototype", name: undefined, orgId: undefined, idempotencyKey: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tier" && args[i + 1]) opts.tier = args[++i];
    // Use !== undefined so an empty-string value is captured (and rejected
    // below) rather than silently dropped by the falsy-check pattern (GH-176).
    if (args[i] === "--name" && args[i + 1] !== undefined) opts.name = args[++i];
    // --org targets an EXISTING org (v1.82); caller needs developer+ on it.
    // Omitted = cold-start. Tier is org-governed, so --tier is irrelevant here
    // (the gateway ignores a client-supplied tier in all cases).
    if (args[i] === "--org" && args[i + 1] !== undefined) opts.orgId = args[++i];
    // Retry-safety: re-running provision (the agent's natural mode after a
    // crash/fresh session) must not duplicate-bill a project.
    if (args[i] === "--idempotency-key" && args[i + 1] !== undefined) opts.idempotencyKey = args[++i];
  }
  // Auto-derive a stable key from --name when none was supplied: a named
  // project is a stable intent, so re-running `provision --name X` collapses
  // onto the same project. An explicit --idempotency-key always wins; an
  // unnamed provision stays un-keyed (each call is a new project on purpose).
  if (opts.idempotencyKey === undefined && opts.name) {
    opts.idempotencyKey = `provision:${opts.name}`;
  }
  if (opts.orgId === "") {
    fail({
      code: "BAD_USAGE",
      message: "--org must not be empty.",
      details: { field: "--org" },
      hint: "Pass an org id (run402 org list), or omit --org for the cold-start path.",
    });
  }
  // Validate --name when provided. Omitted --name lets the server pick a
  // default. The same envelope should also be enforced server-side (GH-176).
  if (opts.name !== undefined) {
    if (opts.name === "") {
      fail({
        code: "BAD_PROJECT_NAME",
        message: "--name must not be empty.",
        details: { field: "--name" },
        hint: "Provide a 1-128 character name, or omit --name to use the server-assigned default.",
      });
    }
    if (opts.name.length > 128) {
      fail({
        code: "BAD_PROJECT_NAME",
        message: `--name must be 1-128 characters, got ${opts.name.length}.`,
        details: { field: "--name", length: opts.name.length, max: 128 },
      });
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(opts.name)) {
      fail({
        code: "BAD_PROJECT_NAME",
        message: "--name contains control characters (newline, tab, etc).",
        details: { field: "--name" },
        hint: "Project names should be a single-line label.",
      });
    }
  }
  // Aggressive early exit when no agent allowance is configured — but only when
  // there's also no operator (control-plane) session, since a wallet-less human
  // provisions into an org via their operator approval instead of a wallet.
  if (!isCoreApiTarget() && !loadLiveControlPlaneSession()) allowanceAuthHeaders("/projects/v1");

  const activeBefore = getActiveProjectId();
  try {
    const data = await withAutoApprove(() =>
      getSdk().projects.provision({ tier: opts.tier, name: opts.name, orgId: opts.orgId, idempotencyKey: opts.idempotencyKey }),
    );
    const activeAfter = getActiveProjectId();
    const out = { ...data };
    if (activeBefore && activeAfter && activeBefore !== activeAfter) {
      out.note = `active project changed: ${activeBefore} -> ${activeAfter}`;
      out.previous_active_project_id = activeBefore;
    }
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function applyExpose(projectId, args = []) {
  let file = null;
  let inline = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) { file = args[++i]; }
    else if (!inline && !args[i].startsWith("--")) { inline = args[i]; }
  }
  if (file) validateRegularFile(file, "--file");
  const raw = file ? readFileSync(file, "utf-8") : inline;
  if (!raw) {
    fail({
      code: "BAD_USAGE",
      message: "Missing manifest.",
      hint: "Provide inline JSON or use --file <path>",
    });
  }
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch (err) {
    fail({
      code: "BAD_USAGE",
      message: "Invalid JSON for manifest",
      details: { parse_error: err.message },
    });
  }
  try {
    const data = await getSdk().projects.applyExpose(projectId, manifest);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function validateExpose(args = []) {
  let projectId = null;
  let file = null;
  let inline = null;
  let migrationFile = null;
  let migrationSql = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--file") {
      if (args[i + 1] === undefined) {
        fail({ code: "BAD_FLAG", message: "--file requires a value", details: { flag: "--file" } });
      }
      file = args[++i];
    }
    else if (arg === "--migration-file") {
      if (args[i + 1] === undefined) {
        fail({ code: "BAD_FLAG", message: "--migration-file requires a value", details: { flag: "--migration-file" } });
      }
      migrationFile = args[++i];
    }
    else if (arg === "--migration-sql") {
      if (args[i + 1] === undefined) {
        fail({ code: "BAD_FLAG", message: "--migration-sql requires a value", details: { flag: "--migration-sql" } });
      }
      migrationSql = args[++i];
    }
    else if (!projectId && typeof arg === "string" && arg.startsWith("prj_")) { projectId = arg; }
    else if (!inline && typeof arg === "string" && !arg.startsWith("--")) { inline = arg; }
    else if (typeof arg === "string" && !arg.startsWith("--")) {
      fail({
        code: "BAD_USAGE",
        message: `Unexpected extra argument: ${arg}`,
        hint: "run402 projects validate-expose [id] <manifest_json>",
      });
    }
  }
  if (file && inline) {
    fail({
      code: "BAD_USAGE",
      message: "Provide either inline manifest JSON or --file <path>, not both.",
      hint: "run402 projects validate-expose [id] --file manifest.json",
    });
  }
  if (migrationFile && migrationSql !== null) {
    fail({
      code: "BAD_USAGE",
      message: "Provide either --migration-file or --migration-sql, not both.",
    });
  }
  if (file) validateRegularFile(file, "--file");
  if (migrationFile) validateRegularFile(migrationFile, "--migration-file");

  let raw = file ? readFileSync(file, "utf-8") : inline;
  if (!raw && process.stdin && process.stdin.isTTY === false) {
    raw = readFileSync(0, "utf-8");
  }
  if (!raw) {
    fail({
      code: "BAD_USAGE",
      message: "Missing manifest.",
      hint: "Provide inline JSON, pipe JSON to stdin, or use --file <path>",
    });
  }

  const activeProjectId = getActiveProjectId();
  const project = projectId || activeProjectId || undefined;
  if (!project) allowanceAuthHeaders("/projects/v1/expose/validate");
  const migration = migrationFile ? readFileSync(migrationFile, "utf-8") : migrationSql;

  try {
    const data = await getSdk().projects.validateExpose(raw, {
      ...(project ? { project } : {}),
      ...(migration !== null && migration !== undefined ? { migrationSql: migration } : {}),
    });
    console.log(JSON.stringify(toCliExposeValidationResult(data), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function getExpose(projectId) {
  try {
    const data = await getSdk().projects.getExpose(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args = []) {
  const org = flagValue(args, "--org");
  const all = Array.isArray(args) && args.includes("--all");
  if (all && org) {
    fail({
      code: "BAD_USAGE",
      message: "--all and --org are mutually exclusive.",
      hint: "--all reads the cross-wallet operator inventory; --org filters the membership-scoped list to one org.",
    });
  }

  // `--all` reads the operator email-union inventory across every wallet
  // controlling your verified email. Pass the cached operator-session token
  // when present (cross-wallet union); otherwise the SDK falls back to SIWX
  // wallet auth and the gateway returns just this wallet's slice.
  const opts = {};
  if (all) {
    opts.all = true;
    const session = loadLiveOperatorSession();
    if (session) opts.token = session.operator_session_token;
  } else if (org) {
    opts.org = org;
  }

  // Active marker comes from local state; the inventory itself is the server
  // read (NOT the keystore), so it surfaces every project the wallet/email can
  // reach — including ones never provisioned from this machine.
  const activeId = getActiveProjectId();

  try {
    const data = await getSdk().projects.list(opts);
    const rows = (data.projects || []).map((p) => ({
      project_id: p.id,
      name: p.name ?? null,
      active: p.id === activeId,
      site_url: p.site_url ?? null,
      custom_domains: p.custom_domains ?? [],
      org_id: p.org_id ?? null,
      status: p.status ?? p.effective_status ?? null,
    }));
    const out = { projects: rows };
    if (data.scope !== undefined) out.scope = data.scope;
    if (data.has_more !== undefined) out.has_more = data.has_more;
    if (data.next_cursor !== undefined && data.next_cursor !== null) out.next_cursor = data.next_cursor;
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function rename(projectId, args = []) {
  const name = flagValue(args, "--name");
  if (!name) {
    fail({
      code: "BAD_USAGE",
      message: "Missing --name.",
      hint: "run402 projects rename <id> --name \"My Site\"",
    });
  }
  try {
    const data = await getSdk().projects.rename(projectId, name);
    console.log(JSON.stringify({ project_id: data.project_id, name: data.name, renamed: true }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function get(projectId) {
  try {
    const data = await getSdk().projects.get(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function info(projectId) {
  try {
    const data = await getSdk().projects.info(projectId);
    console.log(JSON.stringify({
      project_id: projectId,
      rest_url: `${API}/rest/v1`,
      anon_key: data.anon_key,
      service_key: data.service_key,
      site_url: data.site_url || null,
    }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function keys(projectId) {
  try {
    const data = await getSdk().projects.keys(projectId);
    console.log(JSON.stringify({ project_id: projectId, anon_key: data.anon_key, service_key: data.service_key }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function sqlCmd(projectId, args = []) {
  let file = null;
  let query = null;
  let paramsRaw = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) { file = args[++i]; }
    else if (args[i] === "--params" && args[i + 1]) { paramsRaw = args[++i]; }
    else if (!query && !args[i].startsWith("--")) { query = args[i]; }
  }
  if (file) validateRegularFile(file, "--file");
  const sql = file ? readFileSync(file, "utf-8") : query;
  if (!sql) {
    fail({
      code: "BAD_USAGE",
      message: "Missing SQL query.",
      hint: "Provide inline or use --file <path>",
    });
  }
  let params;
  if (paramsRaw) {
    params = parseFlagJson("--params", paramsRaw);
    if (!Array.isArray(params)) {
      fail({
        code: "BAD_USAGE",
        message: "--params must be a JSON array, e.g. '[42, \"hello\"]'",
      });
    }
  }
  try {
    const data = await getSdk().projects.sql(projectId, sql, params);
    console.log(JSON.stringify(toCliSqlResult(data), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

function toCliExposeValidationResult(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  if ("has_errors" in data) return data;
  if (!("hasErrors" in data)) return data;
  const { hasErrors, ...rest } = data;
  return { has_errors: hasErrors, ...rest };
}

function toCliSqlResult(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  if ("row_count" in data) return data;
  if (!("rowCount" in data)) return data;
  const { rowCount, ...rest } = data;
  return { ...rest, row_count: rowCount };
}

async function rest(projectId, table, queryParams) {
  if (!table) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <table> argument. Usage: run402 projects rest [id] <table> [\"<query>\"]",
      hint: "Run 'run402 projects schema <id>' to list tables.",
    });
  }
  try {
    const data = await getSdk().projects.rest(
      projectId,
      table,
      queryParams === undefined ? undefined : { query: queryParams },
    );
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function usage(projectId) {
  try {
    const data = await getSdk().projects.getUsage(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

function adminCookieFromEnv() {
  const raw = process.env.RUN402_ADMIN_COOKIE?.trim();
  if (!raw) return undefined;
  return raw.includes("=") ? raw : `run402_admin=${raw}`;
}

async function costs(projectId, args = []) {
  const window = flagValue(args, "--window") ?? "30d";
  if (!FINANCE_WINDOWS.has(window)) {
    fail({
      code: "BAD_FLAG",
      message: `--window must be one of 24h, 7d, 30d, 90d; got ${window}.`,
      details: { flag: "--window", value: window, allowed: [...FINANCE_WINDOWS] },
    });
  }
  const cookie = adminCookieFromEnv();
  try {
    const data = await getSdk().admin.getProjectFinance(projectId, {
      window,
      ...(cookie ? { cookie } : {}),
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function schema(projectId) {
  try {
    const data = await getSdk().projects.getSchema(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function use(projectId) {
  if (!projectId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <project_id>.",
      hint: "run402 projects use <project_id>",
    });
  }
  try {
    await getSdk().projects.use(projectId);
    console.log(JSON.stringify({ active_project_id: projectId, set: true }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function promoteUser(projectId, email) {
  if (!email) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <email>.",
      hint: "run402 projects promote-user <project_id> <email>",
    });
  }
  try {
    await getSdk().projects.promoteUser(projectId, email);
    console.log(JSON.stringify({ project_id: projectId, email, promoted: true }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function demoteUser(projectId, email) {
  if (!email) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <email>.",
      hint: "run402 projects demote-user <project_id> <email>",
    });
  }
  try {
    await getSdk().projects.demoteUser(projectId, email);
    console.log(JSON.stringify({ project_id: projectId, email, demoted: true }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteProject(projectId, args = []) {
  const confirmed = Array.isArray(args) && args.includes("--confirm");
  if (!confirmed) {
    fail({
      code: "CONFIRMATION_REQUIRED",
      message: `Destructive: deleting project ${projectId} drops all DB schemas, functions, subdomains, mailbox, blobs, and secrets. This is irreversible. Re-run with --confirm to proceed.`,
      details: { project_id: projectId, destroys: ["schemas", "functions", "subdomains", "mailbox", "blobs", "secrets"] },
    });
  }
  try {
    await getSdk().projects.delete(projectId);
    console.log(JSON.stringify({ project_id: projectId, deleted: true }));
  } catch (err) {
    reportSdkError(err);
  }
}

const FLAGS_BY_SUB = {
  provision: {
    known: ["--tier", "--name", "--org", "--idempotency-key"],
    values: ["--tier", "--name", "--org", "--idempotency-key"],
  },
  list: { known: ["--org", "--all"], values: ["--org"] },
  rename: { known: ["--name"], values: ["--name"] },
  sql: { known: ["--file", "--params"], values: ["--file", "--params"] },
  costs: { known: ["--window"], values: ["--window"] },
  "apply-expose": { known: ["--file"], values: ["--file"] },
  "validate-expose": {
    known: ["--file", "--migration-file", "--migration-sql"],
    values: ["--file", "--migration-file", "--migration-sql"],
  },
  delete: { known: ["--confirm"], values: [] },
};

function validateFlags(sub, args) {
  const spec = FLAGS_BY_SUB[sub] ?? { known: [], values: [] };
  assertKnownFlags(args, [...spec.known, "--help", "-h"], spec.values);
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP);
    process.exit(0);
  }
  // v1.57: `projects pin` was removed. Surface a specific hint pointing at the
  // replacement before falling through to the unknown-subcommand handler.
  if (sub === "pin") {
    fail({
      code: "REMOVED_COMMAND",
      message: "`run402 projects pin` was removed in v1.57.",
      hint: "Per-project pin is superseded by the organization-level escape hatch. Use `run402 admin lease-perpetual <org_id> --enable` (platform-admin only).",
    });
  }
  args = normalizeArgv(args);
  if (Array.isArray(args) && hasHelp(args)) {
    console.log(SUB_HELP[sub] || HELP);
    process.exit(0);
  }
  validateFlags(sub, args);
  switch (sub) {
    case "quote":     await quote(); break;
    case "provision": await provision(args); break;
    case "use":       await use(args[0]); break;
    case "list":      await list(args); break;
    case "rename":    { const { projectId, rest } = resolvePositionalProject(args, { rejectBareFirst: true, valueFlags: FLAGS_BY_SUB.rename.values }); await rename(projectId, rest); break; }
    case "get":       { const { projectId } = resolvePositionalProject(args, { rejectBareFirst: true }); await get(projectId); break; }
    case "info":      { const { projectId } = resolvePositionalProject(args, { rejectBareFirst: true }); await info(projectId); break; }
    case "keys":      { const { projectId } = resolvePositionalProject(args, { rejectBareFirst: true }); await keys(projectId); break; }
    case "sql":       { const { projectId, rest } = resolvePositionalProject(args, { maxBarePositionals: 1, valueFlags: FLAGS_BY_SUB.sql.values, rejectBareFirstWhenFlagPresent: ["--file"] }); await sqlCmd(projectId, rest); break; }
    case "rest":      { const { projectId, rest: restArgs } = resolvePositionalProject(args); await rest(projectId, restArgs[0], restArgs[1]); break; }
    case "usage":     { const { projectId } = resolvePositionalProject(args, { rejectBareFirst: true }); await usage(projectId); break; }
    case "costs":     { const { projectId, rest } = resolvePositionalProject(args, { rejectBareFirst: true, valueFlags: FLAGS_BY_SUB.costs.values }); await costs(projectId, rest); break; }
    case "schema":    { const { projectId } = resolvePositionalProject(args, { rejectBareFirst: true }); await schema(projectId); break; }
    case "apply-expose": { const { projectId, rest } = resolvePositionalProject(args, { maxBarePositionals: 1, valueFlags: FLAGS_BY_SUB["apply-expose"].values, rejectBareFirstWhenFlagPresent: ["--file"] }); await applyExpose(projectId, rest); break; }
    case "validate-expose": await validateExpose(args); break;
    case "get-expose":   { const { projectId } = resolvePositionalProject(args, { rejectBareFirst: true }); await getExpose(projectId); break; }
    case "delete":    { const { projectId, rest } = resolvePositionalProject(args, { rejectBareFirst: true }); await deleteProject(projectId, rest); break; }
    case "promote-user": { const { projectId, rest } = resolvePositionalProject(args); await promoteUser(projectId, rest[0]); break; }
    case "demote-user":  { const { projectId, rest } = resolvePositionalProject(args); await demoteUser(projectId, rest[0]); break; }
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
