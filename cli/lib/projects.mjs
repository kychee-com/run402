import { readFileSync } from "fs";
import { findProject, loadKeyStore, API, allowanceAuthHeaders, resolveProjectId, getActiveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail, parseFlagJson } from "./sdk-errors.mjs";
import { assertKnownFlags, failBadProjectId, hasHelp, normalizeArgv, positionalArgs } from "./argparse.mjs";

const HELP = `run402 projects — Manage your deployed Run402 projects

Usage:
  run402 projects <subcommand> [args...]

Subcommands:
  quote                                   Show pricing tiers
  provision [--tier <tier>] [--name <n>]  Provision a new Postgres project (pays via x402)
  use   <id>                              Set the active project (used as default for other commands)
  list                                    List all your projects (IDs, URLs, active marker)
  info  [id]                              Show project details: REST URL, keys
  keys  [id]                              Print anon_key and service_key as JSON
  sql   [id] "<query>" [--file <path>] [--params '<json>']  Run a SQL query (supports parameterized queries)
  rest  [id] <table> [params]             Query a table via the REST API (PostgREST)
  usage [id]                              Show compute/storage usage for a project
  schema [id]                             Inspect the database schema
  apply-expose [id] <manifest_json>       Apply a declarative authorization manifest
  apply-expose [id] --file <path>         Apply a manifest from a JSON file
  get-expose   [id]                       Get the current authorization manifest
  delete [id] --confirm                   Immediately and irreversibly delete a project (cascade purge) and remove from local state. Requires --confirm.
  pin   [id]                              Pin a project (admin only; project owners get 403 admin_required)
  promote-user [id] <email>               Promote a user to project_admin role
  demote-user  [id] <email>               Demote a user from project_admin role

Examples:
  run402 projects quote
  run402 projects provision --tier prototype
  run402 projects provision --tier hobby --name my-app
  run402 projects use prj_abc123
  run402 projects list
  run402 projects info prj_abc123
  run402 projects sql prj_abc123 "SELECT * FROM users LIMIT 5"
  run402 projects sql prj_abc123 "SELECT * FROM users WHERE id = $1" --params '[42]'
  run402 projects sql prj_abc123 --file setup.sql
  run402 projects rest prj_abc123 users "limit=10&select=id,name"
  run402 projects usage prj_abc123
  run402 projects schema prj_abc123
  run402 projects apply-expose prj_abc123 --file manifest.json
  run402 projects get-expose prj_abc123
  run402 projects keys prj_abc123
  run402 projects delete prj_abc123 --confirm

Notes:
  - <id> is the project_id shown in 'run402 projects list' (prefix: 'prj_')
  - Most commands that take <id> default to the active project when omitted
    (set it with 'run402 projects use <id>'). Project IDs start with 'prj_';
    any first positional that doesn't is treated as the next argument instead.
  - 'rest' uses PostgREST query syntax (table name + optional query string)
  - 'provision' requires a funded allowance — payment is automatic via x402
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
`;

const SUB_HELP = {
  provision: `run402 projects provision — Provision a new Postgres project

Usage:
  run402 projects provision [--tier <tier>] [--name <name>]

Options:
  --tier <tier>       Tier for the new project (default: prototype)
  --name <name>       Human-readable name for the project

Notes:
  - Payment is automatic via x402; requires a funded allowance
  - The new project becomes the active project after provisioning

Examples:
  run402 projects provision
  run402 projects provision --tier prototype
  run402 projects provision --tier hobby --name my-app
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
};

async function quote() {
  try {
    const data = await getSdk().projects.getQuote();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function provision(args) {
  const opts = { tier: "prototype", name: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tier" && args[i + 1]) opts.tier = args[++i];
    // Use !== undefined so an empty-string value is captured (and rejected
    // below) rather than silently dropped by the falsy-check pattern (GH-176).
    if (args[i] === "--name" && args[i + 1] !== undefined) opts.name = args[++i];
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
  // Preserve the aggressive early exit when no allowance is configured —
  // gives the user a more specific prompt than the SDK's 401/402 path.
  allowanceAuthHeaders("/projects/v1");

  const activeBefore = getActiveProjectId();
  try {
    const data = await getSdk().projects.provision({ tier: opts.tier, name: opts.name });
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
  const p = findProject(projectId);
  let file = null;
  let inline = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) { file = args[++i]; }
    else if (!inline && !args[i].startsWith("--")) { inline = args[i]; }
  }
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
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/expose`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify(manifest),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function getExpose(projectId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/expose`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function list() {
  const store = loadKeyStore();
  const entries = Object.entries(store.projects);
  if (entries.length === 0) { console.log(JSON.stringify({ status: "ok", projects: [], message: "No projects yet." })); return; }
  const activeId = store.active_project_id;
  console.log(JSON.stringify(entries.map(([id, p]) => ({ project_id: id, active: id === activeId, site_url: p.site_url })), null, 2));
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
  const p = findProject(projectId);
  let file = null;
  let query = null;
  let paramsRaw = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) { file = args[++i]; }
    else if (args[i] === "--params" && args[i + 1]) { paramsRaw = args[++i]; }
    else if (!query && !args[i].startsWith("--")) { query = args[i]; }
  }
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
  const useParams = params && params.length > 0;
  const headers = { "Authorization": `Bearer ${p.service_key}`, "Content-Type": useParams ? "application/json" : "text/plain" };
  const body = useParams ? JSON.stringify({ sql, params }) : sql;
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/sql`, { method: "POST", headers, body });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function rest(projectId, table, queryParams) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/rest/v1/${table}${queryParams ? '?' + queryParams : ''}`, { headers: { "apikey": p.anon_key } });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function usage(projectId) {
  try {
    const data = await getSdk().projects.getUsage(projectId);
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
    console.log(JSON.stringify({ status: "ok", active_project_id: projectId }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function pin(projectId) {
  if (!projectId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <project_id>.",
      hint: "run402 projects pin <project_id>",
    });
  }
  try {
    const data = await getSdk().projects.pin(projectId);
    console.log(JSON.stringify(data, null, 2));
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
  const p = findProject(projectId);
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/promote-user`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function demoteUser(projectId, email) {
  if (!email) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <email>.",
      hint: "run402 projects demote-user <project_id> <email>",
    });
  }
  const p = findProject(projectId);
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/demote-user`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function deleteProject(projectId, args = []) {
  const confirmed = Array.isArray(args) && args.includes("--confirm");
  if (!confirmed) {
    console.error(JSON.stringify({
      status: "error",
      code: "CONFIRMATION_REQUIRED",
      message: `Destructive: deleting project ${projectId} drops all DB schemas, functions, subdomains, mailbox, blobs, and secrets. This is irreversible. Re-run with --confirm to proceed.`,
      details: { project_id: projectId, destroys: ["schemas", "functions", "subdomains", "mailbox", "blobs", "secrets"] },
    }));
    process.exit(1);
  }
  try {
    await getSdk().projects.delete(projectId);
    console.log(JSON.stringify({ status: "ok", message: `Project ${projectId} deleted.` }));
  } catch (err) {
    reportSdkError(err);
  }
}

// Resolve a positional project_id argument with active-project fallback (GH-102).
// Callers can tighten the legacy shorthand when a bare non-prj positional is
// more likely a mistyped project id than an argument for the active project.
function resolvePositionalProject(args, opts = {}) {
  const first = Array.isArray(args) ? args[0] : undefined;
  if (typeof first === "string" && first.startsWith("prj_")) {
    return { projectId: first, rest: args.slice(1) };
  }
  if (
    typeof first === "string" &&
    first.length > 0 &&
    !first.startsWith("-") &&
    Array.isArray(opts.rejectBareFirstWhenFlagPresent) &&
    opts.rejectBareFirstWhenFlagPresent.some((flag) => args.includes(flag))
  ) {
    failBadProjectId(first);
  }
  if (typeof first === "string" && first.length > 0 && !first.startsWith("-") && opts.rejectBareFirst) {
    failBadProjectId(first);
  }
  if (typeof first === "string" && first.length > 0 && !first.startsWith("-") && opts.maxBarePositionals !== undefined) {
    const bare = positionalArgs(args, opts.valueFlags ?? []);
    if (bare.length > opts.maxBarePositionals) {
      failBadProjectId(first);
    }
  }
  return { projectId: resolveProjectId(null), rest: Array.isArray(args) ? args : [] };
}

const FLAGS_BY_SUB = {
  provision: { known: ["--tier", "--name"], values: ["--tier", "--name"] },
  sql: { known: ["--file", "--params"], values: ["--file", "--params"] },
  "apply-expose": { known: ["--file"], values: ["--file"] },
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
    case "list":      await list(); break;
    case "info":      { const { projectId } = resolvePositionalProject(args, { rejectBareFirst: true }); await info(projectId); break; }
    case "keys":      { const { projectId } = resolvePositionalProject(args, { rejectBareFirst: true }); await keys(projectId); break; }
    case "sql":       { const { projectId, rest } = resolvePositionalProject(args, { maxBarePositionals: 1, valueFlags: FLAGS_BY_SUB.sql.values, rejectBareFirstWhenFlagPresent: ["--file"] }); await sqlCmd(projectId, rest); break; }
    case "rest":      { const { projectId, rest: restArgs } = resolvePositionalProject(args); await rest(projectId, restArgs[0], restArgs[1]); break; }
    case "usage":     { const { projectId } = resolvePositionalProject(args, { rejectBareFirst: true }); await usage(projectId); break; }
    case "schema":    { const { projectId } = resolvePositionalProject(args, { rejectBareFirst: true }); await schema(projectId); break; }
    case "apply-expose": { const { projectId, rest } = resolvePositionalProject(args, { maxBarePositionals: 1, valueFlags: FLAGS_BY_SUB["apply-expose"].values, rejectBareFirstWhenFlagPresent: ["--file"] }); await applyExpose(projectId, rest); break; }
    case "get-expose":   { const { projectId } = resolvePositionalProject(args, { rejectBareFirst: true }); await getExpose(projectId); break; }
    case "delete":    { const { projectId, rest } = resolvePositionalProject(args, { rejectBareFirst: true }); await deleteProject(projectId, rest); break; }
    case "pin":       { const { projectId } = resolvePositionalProject(args, { rejectBareFirst: true }); await pin(projectId); break; }
    case "promote-user": { const { projectId, rest } = resolvePositionalProject(args); await promoteUser(projectId, rest[0]); break; }
    case "demote-user":  { const { projectId, rest } = resolvePositionalProject(args); await demoteUser(projectId, rest[0]); break; }
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
