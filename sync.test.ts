/**
 * sync.test.ts — Ensures MCP, CLI, and OpenClaw interfaces stay in sync
 * with the Run402 API surface defined in llms.txt.
 *
 * Run:  node --test --import tsx sync.test.ts
 *       npm run test:sync
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELEASE_SPEC_SCHEMA_URL = "https://run402.com/schemas/release-spec.v1.json";
const RELEASE_SPEC_SCHEMA_PATH = join(__dirname, "schemas/release-spec.v1.json");

// ─── Source-file parsers ─────────────────────────────────────────────────────

/** Extract all server.tool("name", ...) registrations from src/index.ts */
function parseMcpTools(): string[] {
  const src = readFileSync(join(__dirname, "src/index.ts"), "utf-8");
  const tools: string[] = [];
  const re = /server\.tool\(\s*\n?\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) tools.push(m[1]);
  return tools.sort();
}

/** Extract subcommand names from a .mjs file.
 *  Matches both switch/case patterns and if-guard patterns like:
 *    case "generate":           → "generate"
 *    if (sub !== "generate")    → "generate"  (negation = only valid subcommand)
 *  Follows re-exports: export { run } from "../../cli/lib/foo.mjs" → parse that file
 */
function parseSubcommands(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const src = readFileSync(filePath, "utf-8");

  // Follow re-exports to the target file
  const reExportMatch = src.match(/export\s+\{[^}]*run[^}]*\}\s+from\s+["']([^"']+)["']/);
  if (reExportMatch) {
    const targetPath = join(dirname(filePath), reExportMatch[1]);
    return parseSubcommands(targetPath);
  }

  const cmds: string[] = [];
  // Pattern 1: switch/case
  const caseRe = /case\s+"([\w-]+)":/g;
  let m;
  while ((m = caseRe.exec(src))) cmds.push(m[1]);
  // Pattern 2: if (sub !== "word") — the word is the only valid subcommand
  const guardRe = /if\s*\(\s*sub\s*!==\s*"(\w+)"\s*\)/g;
  while ((m = guardRe.exec(src))) cmds.push(m[1]);
  // Deduplicate and filter out help/flag checks
  return [...new Set(cmds)].filter(c => c !== "help" && !c.startsWith("-")).sort();
}

/** Parse CLI commands as "module:subcommand" pairs */
function parseCliCommands(): string[] {
  const cmds: string[] = [];
  for (const mod of ["admin", "allowance", "wallets", "tier", "projects", "image", "storage", "assets", "cache", "cdn", "functions", "secrets", "jobs", "sites", "subdomains", "domains", "apps", "email", "message", "agent", "operator", "ai", "auth", "sender-domain", "billing", "contracts", "webhooks", "service", "deploy", "ci", "transfer", "org", "grants", "notifications", "webhook-secret", "cloud", "archives", "core"]) {
    for (const sub of parseSubcommands(join(__dirname, "cli/lib", `${mod}.mjs`))) {
      cmds.push(`${mod}:${sub}`);
    }
  }
  for (const action of parseCloudArchiveActions("cli/lib/cloud.mjs")) cmds.push(`cloud:archives:${action}`);
  for (const action of parseCoreProjectActions("cli/lib/core.mjs")) cmds.push(`core:projects:${action}`);
  for (const action of parseDeployReleaseActions()) {
    cmds.push(`deploy:release:${action}`);
  }
  for (const action of parseJobsArtifactsActions()) {
    cmds.push(`jobs:artifacts:${action}`);
  }
  for (const action of parseOrgGroupActions("memberAction")) cmds.push(`org:member:${action}`);
  for (const action of parseOrgGroupActions("inviteAction")) cmds.push(`org:invite:${action}`);
  if (existsSync(join(__dirname, "cli/lib/init.mjs"))) cmds.push("init");
  if (existsSync(join(__dirname, "cli/lib/up.mjs"))) cmds.push("up");
  if (existsSync(join(__dirname, "cli/lib/status.mjs"))) cmds.push("status");
  if (existsSync(join(__dirname, "cli/lib/doctor.mjs"))) cmds.push("doctor");
  if (existsSync(join(__dirname, "cli/lib/dev.mjs"))) cmds.push("dev");
  if (existsSync(join(__dirname, "cli/lib/logs.mjs"))) cmds.push("logs");
  return cmds.sort();
}

/** Parse OpenClaw commands as "module:subcommand" pairs */
function parseOpenClawCommands(): string[] {
  const cmds: string[] = [];
  for (const mod of ["admin", "allowance", "wallets", "tier", "projects", "image", "storage", "assets", "cache", "cdn", "functions", "secrets", "jobs", "sites", "subdomains", "domains", "apps", "email", "message", "agent", "operator", "ai", "auth", "sender-domain", "billing", "contracts", "webhooks", "service", "deploy", "ci", "transfer", "org", "grants", "notifications", "webhook-secret", "cloud", "archives", "core"]) {
    for (const sub of parseSubcommands(join(__dirname, "openclaw/scripts", `${mod}.mjs`))) {
      cmds.push(`${mod}:${sub}`);
    }
  }
  for (const action of parseCloudArchiveActions("cli/lib/cloud.mjs")) cmds.push(`cloud:archives:${action}`);
  for (const action of parseCoreProjectActions("cli/lib/core.mjs")) cmds.push(`core:projects:${action}`);
  for (const action of parseDeployReleaseActions()) {
    cmds.push(`deploy:release:${action}`);
  }
  for (const action of parseJobsArtifactsActions()) {
    cmds.push(`jobs:artifacts:${action}`);
  }
  for (const action of parseOrgGroupActions("memberAction")) cmds.push(`org:member:${action}`);
  for (const action of parseOrgGroupActions("inviteAction")) cmds.push(`org:invite:${action}`);
  if (existsSync(join(__dirname, "openclaw/scripts/init.mjs"))) cmds.push("init");
  if (existsSync(join(__dirname, "openclaw/scripts/up.mjs"))) cmds.push("up");
  if (existsSync(join(__dirname, "openclaw/scripts/status.mjs"))) cmds.push("status");
  if (existsSync(join(__dirname, "openclaw/scripts/doctor.mjs"))) cmds.push("doctor");
  if (existsSync(join(__dirname, "openclaw/scripts/dev.mjs"))) cmds.push("dev");
  if (existsSync(join(__dirname, "openclaw/scripts/logs.mjs"))) cmds.push("logs");
  return cmds.sort();
}

function parseDeployReleaseActions(): string[] {
  const filePath = join(__dirname, "cli/lib/deploy-v2.mjs");
  if (!existsSync(filePath)) return [];
  const src = readFileSync(filePath, "utf-8");
  const actions: string[] = [];
  const re = /if\s*\(\s*action\s*===\s*"([\w-]+)"\s*\)/g;
  let m;
  while ((m = re.exec(src))) actions.push(m[1]);
  return [...new Set(actions)].sort();
}

/** Parse the nested `jobs artifacts <action>` leaf actions from cli/lib/jobs.mjs.
 *  The `artifacts` group is dispatched via an `if (sub === "artifacts")` branch
 *  (not a switch case) so per-action `--help` resolves correctly; its actions
 *  are matched on `if (action === "...")`, mirroring `deploy release`. */
function parseJobsArtifactsActions(): string[] {
  const filePath = join(__dirname, "cli/lib/jobs.mjs");
  if (!existsSync(filePath)) return [];
  const src = readFileSync(filePath, "utf-8");
  const actions: string[] = [];
  const re = /if\s*\(\s*action\s*===\s*"([\w-]+)"\s*\)/g;
  let m;
  while ((m = re.exec(src))) actions.push(m[1]);
  return [...new Set(actions)].sort();
}

function parseCloudArchiveActions(relativePath: string): string[] {
  const filePath = join(__dirname, relativePath);
  if (!existsSync(filePath)) return [];
  const src = readFileSync(filePath, "utf-8");
  const actions: string[] = [];
  const re = /action\s*===\s*"([\w-]+)"/g;
  let m;
  while ((m = re.exec(src))) actions.push(m[1]);
  return [...new Set(actions)].sort();
}

function parseCoreProjectActions(relativePath: string): string[] {
  const filePath = join(__dirname, relativePath);
  if (!existsSync(filePath)) return [];
  const src = readFileSync(filePath, "utf-8");
  const actions: string[] = [];
  const re = /action\s*===\s*"([\w-]+)"/g;
  let m;
  while ((m = re.exec(src))) actions.push(m[1]);
  return [...new Set(actions)].sort();
}

/** Parse the nested `org member <action>` / `org invite <action>` leaf actions
 *  from cli/lib/org.mjs (matched on `memberAction === "..."` / `inviteAction ===
 *  "..."`), mirroring `jobs artifacts`. The groups dispatch via `if (sub === ...)`
 *  so parseSubcommands skips them; these surface their leaves instead. */
function parseOrgGroupActions(varName: "memberAction" | "inviteAction"): string[] {
  const filePath = join(__dirname, "cli/lib/org.mjs");
  if (!existsSync(filePath)) return [];
  const src = readFileSync(filePath, "utf-8");
  const actions: string[] = [];
  const re = new RegExp(`${varName}\\s*===\\s*"([\\w-]+)"`, "g");
  let m;
  while ((m = re.exec(src))) actions.push(m[1]);
  return [...new Set(actions)].filter((c) => c !== "help" && !c.startsWith("-")).sort();
}

// ─── Canonical API surface ───────────────────────────────────────────────────
// Source of truth: llms.txt at run402.com/llms.txt
// Each entry maps an API endpoint to its expected tool/command in each interface.
//
// null = not applicable for this interface (e.g. local-only tools)
// string = expected tool/command name
//
// When you add a new endpoint or tool, add it here. The test will fail if
// the implementation doesn't match.

interface Capability {
  /** Human-readable capability name */
  id: string;
  /** API endpoint(s) from llms.txt */
  endpoint: string;
  /** Expected MCP tool name, or null if intentionally excluded */
  mcp: string | null;
  /** Expected CLI command as "module:sub" or "module", or null */
  cli: string | null;
  /** Expected OpenClaw command (must match CLI if both non-null) */
  openclaw: string | null;
}

const SURFACE: Capability[] = [
  // ── Init / status (local-only) ──────────────────────────────────────────
  { id: "up",                endpoint: "(compound local+gateway action)",       mcp: "app_up",                        cli: "up",                  openclaw: "up" },
  { id: "init",              endpoint: "(local)",                              mcp: "init",                          cli: "init",                openclaw: "init" },
  { id: "status",            endpoint: "(local)",                              mcp: "status",                        cli: "status",              openclaw: "status" },

  // ── Named wallets / profiles (local-only management; selection via --wallet) ─
  { id: "wallets_list",      endpoint: "(local)",                              mcp: null, cli: "wallets:list",     openclaw: "wallets:list" },
  { id: "wallets_current",   endpoint: "(local)",                              mcp: null, cli: "wallets:current",  openclaw: "wallets:current" },
  { id: "wallets_new",       endpoint: "(local)",                              mcp: null, cli: "wallets:new",      openclaw: "wallets:new" },
  { id: "wallets_use",       endpoint: "(local)",                              mcp: null, cli: "wallets:use",      openclaw: "wallets:use" },
  { id: "wallets_rename",    endpoint: "(local)",                              mcp: null, cli: "wallets:rename",   openclaw: "wallets:rename" },
  { id: "wallets_bind",      endpoint: "(local)",                              mcp: null, cli: "wallets:bind",     openclaw: "wallets:bind" },
  { id: "wallets_unbind",    endpoint: "(local)",                              mcp: null, cli: "wallets:unbind",   openclaw: "wallets:unbind" },
  { id: "wallets_import",    endpoint: "(local)",                              mcp: null, cli: "wallets:import",   openclaw: "wallets:import" },
  { id: "wallets_rm",        endpoint: "(local)",                              mcp: null, cli: "wallets:rm",       openclaw: "wallets:rm" },

  // ── SSR Runtime DX (v1.52, local-only / CLI-only) ──────────────────────
  // doctor / dev / logs are agent-DX shortcuts: no MCP/SDK tool, just CLI parity with OpenClaw.
  { id: "doctor",            endpoint: "(local)",                              mcp: null,                            cli: "doctor",              openclaw: "doctor" },
  { id: "dev",               endpoint: "(local)",                              mcp: null,                            cli: "dev",                 openclaw: "dev" },
  { id: "logs",              endpoint: "GET /functions/v1/:name/logs (filtered)", mcp: null,                         cli: "logs",                openclaw: "logs" },

  // ── SSR origin cache (v1.52) ────────────────────────────────────────────
  { id: "cache_invalidate",  endpoint: "POST /cache/v1/invalidate",            mcp: null,                            cli: "cache:invalidate",    openclaw: "cache:invalidate" },
  { id: "cache_inspect",     endpoint: "GET /cache/v1/inspect",                mcp: null,                            cli: "cache:inspect",       openclaw: "cache:inspect" },

  // ── Project lifecycle ────────────────────────────────────────────────────
  { id: "get_quote",         endpoint: "POST /projects/v1/quote",                mcp: "get_quote",                    cli: "projects:quote",      openclaw: "projects:quote" },
  { id: "provision",         endpoint: "POST /projects/v1",                      mcp: "provision_postgres_project",    cli: "projects:provision",  openclaw: "projects:provision" },
  { id: "set_tier",           endpoint: "POST /tiers/v1/:tier",                   mcp: "set_tier",                      cli: "tier:set",            openclaw: "tier:set" },
  { id: "delete",            endpoint: "DELETE /projects/v1/:id",                mcp: "delete_project",                cli: "projects:delete",     openclaw: "projects:delete" },
  { id: "export_project_archive", endpoint: "POST /projects/v1/:project_id/archives", mcp: "export_project_archive", cli: "cloud:archives:create", openclaw: "cloud:archives:create" },
  { id: "download_project_archive", endpoint: "GET /projects/v1/:project_id/archives/:archive_id/download", mcp: null, cli: "cloud:archives:download", openclaw: "cloud:archives:download" },
  { id: "get_project_archive", endpoint: "GET /projects/v1/:project_id/archives/:archive_id", mcp: null, cli: "cloud:archives:status", openclaw: "cloud:archives:status" },
  { id: "inspect_project_archive", endpoint: "(local archive inspect)", mcp: "inspect_project_archive", cli: "archives:inspect", openclaw: "archives:inspect" },
  { id: "verify_project_archive", endpoint: "(local archive verify)", mcp: "verify_project_archive", cli: "archives:verify", openclaw: "archives:verify" },
  { id: "import_project_archive", endpoint: "POST /archives/v1/import (Run402 Core)", mcp: "import_project_archive", cli: "core:projects:import", openclaw: "core:projects:import" },

  // ── Faucet ───────────────────────────────────────────────────────────────
  { id: "faucet",            endpoint: "POST /faucet/v1",                        mcp: "request_faucet",                cli: "allowance:fund",      openclaw: "allowance:fund" },

  // ── Database / Admin ─────────────────────────────────────────────────────
  { id: "run_sql",           endpoint: "POST /projects/v1/admin/:id/sql",        mcp: "run_sql",                       cli: "projects:sql",        openclaw: "projects:sql" },
  { id: "rest_query",        endpoint: "/rest/v1/:table",                        mcp: "rest_query",                    cli: "projects:rest",       openclaw: "projects:rest" },
  { id: "apply_expose",      endpoint: "POST /projects/v1/admin/:id/expose",     mcp: "apply_expose",                  cli: "projects:apply-expose", openclaw: "projects:apply-expose" },
  { id: "validate_manifest", endpoint: "POST /projects/v1/expose/validate",      mcp: "validate_manifest",             cli: "projects:validate-expose", openclaw: "projects:validate-expose" },
  { id: "get_expose",        endpoint: "GET /projects/v1/admin/:id/expose",      mcp: "get_expose",                    cli: "projects:get-expose",   openclaw: "projects:get-expose" },
  { id: "get_schema",        endpoint: "GET /projects/v1/admin/:id/schema",      mcp: "get_schema",                    cli: "projects:schema",     openclaw: "projects:schema" },
  { id: "get_usage",         endpoint: "GET /projects/v1/admin/:id/usage",       mcp: "get_usage",                     cli: "projects:usage",      openclaw: "projects:usage" },

  // ── Assets (direct-to-S3 storage, v1.48 unified-apply rename of blobs) ──
  { id: "assets_put",        endpoint: "POST /apply/v1/plans",                   mcp: "assets_put",     cli: "assets:put",       openclaw: "assets:put" },
  { id: "assets_get",        endpoint: "GET /storage/v1/blob/{key}",             mcp: "assets_get",     cli: "assets:get",       openclaw: "assets:get" },
  { id: "assets_ls",         endpoint: "GET /storage/v1/blobs",                  mcp: "assets_ls",      cli: "assets:ls",        openclaw: "assets:ls" },
  { id: "assets_rm",         endpoint: "DELETE /storage/v1/blob/{key}",          mcp: "assets_rm",      cli: "assets:rm",        openclaw: "assets:rm" },
  { id: "assets_sign",       endpoint: "POST /storage/v1/blob/{key}/sign",       mcp: "assets_sign",    cli: "assets:sign",      openclaw: "assets:sign" },
  // v1.45: agent-DX CDN diagnostics for asset URLs (CLI: assets diagnose / cdn wait-fresh).
  { id: "diagnose_public_url",   endpoint: "GET /storage/v1/blobs/diagnose",       mcp: "diagnose_public_url",     cli: "assets:diagnose",   openclaw: "assets:diagnose" },
  { id: "wait_for_cdn_freshness", endpoint: "GET /storage/v1/blobs/diagnose (poll)", mcp: "wait_for_cdn_freshness",  cli: "cdn:wait-fresh",    openclaw: "cdn:wait-fresh" },

  // ── Functions ────────────────────────────────────────────────────────────
  { id: "deploy_function",   endpoint: "POST /apply/v1/plans (functions.patch.set)",          mcp: "deploy_function",   cli: "functions:deploy", openclaw: "functions:deploy" },
  { id: "invoke_function",   endpoint: "POST /functions/v1/:name",                            mcp: "invoke_function",   cli: "functions:invoke", openclaw: "functions:invoke" },
  { id: "get_function_logs", endpoint: "GET /projects/v1/admin/:id/functions/:name/logs",    mcp: "get_function_logs", cli: "functions:logs",   openclaw: "functions:logs" },
  { id: "list_functions",    endpoint: "GET /projects/v1/admin/:id/functions",                mcp: "list_functions",    cli: "functions:list",   openclaw: "functions:list" },
  { id: "delete_function",   endpoint: "DELETE /projects/v1/admin/:id/functions/:name",      mcp: "delete_function",   cli: "functions:delete", openclaw: "functions:delete" },
  { id: "update_function",   endpoint: "PATCH /projects/v1/admin/:id/functions/:name",     mcp: "update_function",   cli: "functions:update", openclaw: "functions:update" },
  // function-runtime-rebuild (v1.69): opt-in refresh onto the current platform
  // runtime. The CLI `functions rebuild [name] [--all]` collapses the single
  // (`:name/rebuild`) and project-wide (`/rebuild`) endpoints into one verb;
  // the batch SDK method is in SDK_ONLY_METHODS. MCP tool `functions_rebuild`
  // (name → single, omitted → batch) landed the deferred gh#416 follow-up.
  { id: "rebuild_function",  endpoint: "POST /projects/v1/:id/functions/:name/rebuild",     mcp: "functions_rebuild", cli: "functions:rebuild", openclaw: "functions:rebuild" },
  // durable-function-requests: one CLI/OpenClaw `functions runs <action>` group
  // maps to six MCP tools and typed SDK methods.
  { id: "create_function_run", endpoint: "POST /functions/v1/:name/runs",        mcp: "create_function_run",       cli: "functions:runs", openclaw: "functions:runs" },
  { id: "list_function_runs",  endpoint: "GET /functions/v1/:name/runs",         mcp: "list_function_runs",        cli: null, openclaw: null },
  { id: "get_function_run",    endpoint: "GET /functions/v1/runs/:run_id",       mcp: "get_function_run",          cli: null, openclaw: null },
  { id: "get_function_run_logs", endpoint: "GET /functions/v1/runs/:run_id/logs", mcp: "get_function_run_logs",    cli: null, openclaw: null },
  { id: "cancel_function_run", endpoint: "POST /functions/v1/runs/:run_id/cancel", mcp: "cancel_function_run",     cli: null, openclaw: null },
  { id: "redrive_function_run", endpoint: "POST /functions/v1/runs/:run_id/redrive", mcp: "redrive_function_run",  cli: null, openclaw: null },

  // ── Secrets ──────────────────────────────────────────────────────────────
  { id: "set_secret",        endpoint: "POST /projects/v1/admin/:id/secrets",        mcp: "set_secret",    cli: "secrets:set",    openclaw: "secrets:set" },
  { id: "list_secrets",      endpoint: "GET /projects/v1/admin/:id/secrets",         mcp: "list_secrets",  cli: "secrets:list",   openclaw: "secrets:list" },
  { id: "delete_secret",     endpoint: "DELETE /projects/v1/admin/:id/secrets/:key", mcp: "delete_secret", cli: "secrets:delete", openclaw: "secrets:delete" },

  // ── Managed jobs ────────────────────────────────────────────────────────
  { id: "jobs_submit",       endpoint: "POST /jobs/v1/runs",                 mcp: "jobs_submit", cli: "jobs:submit", openclaw: "jobs:submit" },
  { id: "jobs_get",          endpoint: "GET /jobs/v1/runs/:job_id",          mcp: "jobs_get",    cli: "jobs:get",    openclaw: "jobs:get" },
  { id: "jobs_logs",         endpoint: "GET /jobs/v1/runs/:job_id/logs",     mcp: "jobs_logs",   cli: "jobs:logs",   openclaw: "jobs:logs" },
  { id: "jobs_cancel",       endpoint: "DELETE /jobs/v1/runs/:job_id",       mcp: "jobs_cancel", cli: "jobs:cancel", openclaw: "jobs:cancel" },
  { id: "jobs_purge",        endpoint: "DELETE /jobs/v1/runs",               mcp: "jobs_purge",  cli: "jobs:purge",  openclaw: "jobs:purge" },
  { id: "jobs_download_artifact", endpoint: "GET /jobs/v1/runs/:job_id/artifacts/:filename", mcp: "jobs_download_artifact", cli: "jobs:artifacts:get", openclaw: "jobs:artifacts:get" },

  // ── Sites / Subdomains ───────────────────────────────────────────────────
  { id: "deploy_site",       endpoint: "POST /apply/v1/plans",             mcp: "deploy_site",       cli: "sites:deploy",       openclaw: "sites:deploy" },
  { id: "deploy_site_dir",   endpoint: "POST /apply/v1/plans",             mcp: "deploy_site_dir",   cli: "sites:deploy-dir",   openclaw: "sites:deploy-dir" },
  { id: "claim_subdomain",   endpoint: "POST /subdomains/v1",              mcp: "claim_subdomain",   cli: "subdomains:claim",   openclaw: "subdomains:claim" },
  { id: "delete_subdomain",  endpoint: "DELETE /subdomains/v1/:name",      mcp: "delete_subdomain",  cli: "subdomains:delete",  openclaw: "subdomains:delete" },
  { id: "list_subdomains",   endpoint: "GET /subdomains/v1",               mcp: "list_subdomains",   cli: "subdomains:list",    openclaw: "subdomains:list" },

  // ── Custom domains ──────────────────────────────────────────────────────
  { id: "add_custom_domain",    endpoint: "POST /domains/v1",              mcp: "add_custom_domain",    cli: "domains:add",    openclaw: "domains:add" },
  { id: "list_custom_domains",  endpoint: "GET /domains/v1",               mcp: "list_custom_domains",  cli: "domains:list",   openclaw: "domains:list" },
  { id: "check_domain_status",  endpoint: "GET /domains/v1/:domain",       mcp: "check_domain_status",  cli: "domains:status", openclaw: "domains:status" },
  { id: "remove_custom_domain", endpoint: "DELETE /domains/v1/:domain",    mcp: "remove_custom_domain", cli: "domains:delete", openclaw: "domains:delete" },

  // ── Unified apply ────────────────────────────────────────────────────────
  { id: "deploy",            endpoint: "POST /apply/v1/plans",                            mcp: "deploy",            cli: "deploy:apply",      openclaw: "deploy:apply" },
  { id: "deploy_resume",     endpoint: "POST /apply/v1/operations/:operation_id/resume",            mcp: "deploy_resume",     cli: "deploy:resume",     openclaw: "deploy:resume" },
  { id: "deploy_promote",    endpoint: "POST /apply/v1/releases/:release_id/promote",              mcp: null,                cli: "deploy:promote",    openclaw: "deploy:promote" },
  { id: "deploy_list",       endpoint: "GET /apply/v1/operations",                        mcp: "deploy_list",       cli: "deploy:list",       openclaw: "deploy:list" },
  { id: "deploy_events",     endpoint: "GET /apply/v1/operations/:operation_id/events",             mcp: "deploy_events",     cli: "deploy:events",     openclaw: "deploy:events" },
  { id: "deploy_release_get",    endpoint: "GET /apply/v1/releases/:release_id",                  mcp: "deploy_release_get",    cli: "deploy:release:get",    openclaw: "deploy:release:get" },
  { id: "deploy_release_active", endpoint: "GET /apply/v1/releases/active",               mcp: "deploy_release_active", cli: "deploy:release:active", openclaw: "deploy:release:active" },
  { id: "deploy_release_diff",   endpoint: "GET /apply/v1/releases/diff",                 mcp: "deploy_release_diff",   cli: "deploy:release:diff",   openclaw: "deploy:release:diff" },
  { id: "deploy_diagnose_url",   endpoint: "GET /apply/v1/resolve",                       mcp: "deploy_diagnose_url",   cli: "deploy:diagnose",       openclaw: "deploy:diagnose" },
  { id: "deploy_resolve",        endpoint: "GET /apply/v1/resolve",                       mcp: null,                    cli: "deploy:resolve",        openclaw: "deploy:resolve" },

  // ── CI/OIDC federation ──────────────────────────────────────────────────
  { id: "ci_link_github",    endpoint: "POST /ci/v1/bindings",                              mcp: "ci_create_binding", cli: "ci:link",          openclaw: "ci:link" },
  { id: "ci_list_bindings",  endpoint: "GET /ci/v1/bindings",                               mcp: "ci_list_bindings",  cli: "ci:list",          openclaw: "ci:list" },
  { id: "ci_get_binding",    endpoint: "GET /ci/v1/bindings/:id",                           mcp: "ci_get_binding",    cli: null,               openclaw: null },
  { id: "ci_revoke_binding", endpoint: "POST /ci/v1/bindings/:id/revoke",                   mcp: "ci_revoke_binding", cli: "ci:revoke",        openclaw: "ci:revoke" },
  { id: "ci_set_asset_scopes", endpoint: "POST /ci/v1/bindings/:id/asset-scopes",            mcp: null,                cli: "ci:set-asset-scopes", openclaw: "ci:set-asset-scopes" },

  // ── Marketplace ──────────────────────────────────────────────────────────
  { id: "browse_apps",       endpoint: "GET /apps/v1",                              mcp: "browse_apps",   cli: "apps:browse",   openclaw: "apps:browse" },
  { id: "fork_app",          endpoint: "POST /fork/v1",                             mcp: "fork_app",      cli: "apps:fork",     openclaw: "apps:fork" },
  { id: "publish_app",       endpoint: "POST /projects/v1/admin/:id/publish",       mcp: "publish_app",   cli: "apps:publish",  openclaw: "apps:publish" },
  { id: "list_versions",     endpoint: "GET /projects/v1/admin/:id/versions",       mcp: "list_versions", cli: "apps:versions", openclaw: "apps:versions" },

  // ── Billing ──────────────────────────────────────────────────────────────
  { id: "check_balance",     endpoint: "GET /orgs/v1/lookup?wallet=",           mcp: "check_balance",  cli: "allowance:balance", openclaw: "allowance:balance" },
  { id: "list_projects",     endpoint: "GET /projects/v1",                           mcp: "list_projects",  cli: "projects:list",  openclaw: "projects:list" },
  { id: "rename_project",    endpoint: "PATCH /projects/v1/:project_id",             mcp: "rename_project", cli: "projects:rename", openclaw: "projects:rename" },
  { id: "project_get",       endpoint: "GET /projects/v1/:project_id",               mcp: "project_get",    cli: "projects:get",   openclaw: "projects:get" },
  { id: "project_info",      endpoint: "(local)",                                    mcp: "project_info",   cli: "projects:info",  openclaw: "projects:info" },
  { id: "project_use",       endpoint: "(local)",                                    mcp: "project_use",    cli: "projects:use",   openclaw: "projects:use" },
  { id: "project_keys",      endpoint: "(local)",                                    mcp: "project_keys",   cli: "projects:keys",  openclaw: "projects:keys" },

  // ── Image generation ─────────────────────────────────────────────────────
  { id: "generate_image",    endpoint: "POST /generate-image/v1",           mcp: "generate_image",   cli: "image:generate",   openclaw: "image:generate" },

  // ── Email ──────────────────────────────────────────────────────────────
  { id: "create_mailbox",  endpoint: "POST /mailboxes/v1",                      mcp: "create_mailbox",  cli: "email:create",  openclaw: "email:create" },
  { id: "list_mailboxes",  endpoint: "GET /mailboxes/v1",                       mcp: "list_mailboxes",   cli: "email:mailboxes", openclaw: "email:mailboxes" },
  { id: "set_mailbox_defaults", endpoint: "PATCH /mailboxes/v1/settings",        mcp: "set_mailbox_defaults", cli: "email:defaults", openclaw: "email:defaults" },
  { id: "update_mailbox",  endpoint: "PATCH /mailboxes/v1/:mailbox_id",          mcp: "update_mailbox",  cli: "email:update",  openclaw: "email:update" },
  { id: "send_email",      endpoint: "POST /mailboxes/v1/:mailbox_id/messages",         mcp: "send_email",      cli: "email:send",    openclaw: "email:send" },
  { id: "list_emails",     endpoint: "GET /mailboxes/v1/:mailbox_id/messages",          mcp: "list_emails",     cli: "email:list",    openclaw: "email:list" },
  { id: "get_email",       endpoint: "GET /mailboxes/v1/:mailbox_id/messages/:message_id",   mcp: "get_email",       cli: "email:get",     openclaw: "email:get" },
  { id: "get_email_raw",   endpoint: "GET /mailboxes/v1/:mailbox_id/messages/:message_id/raw", mcp: "get_email_raw", cli: "email:get-raw", openclaw: "email:get-raw" },
  { id: "get_mailbox",     endpoint: "GET /mailboxes/v1",                        mcp: "get_mailbox",     cli: "email:info",    openclaw: "email:info" },
  { id: "delete_mailbox",  endpoint: "DELETE /mailboxes/v1/:mailbox_id",                 mcp: "delete_mailbox",  cli: "email:delete",  openclaw: "email:delete" },
  { id: "reply_email",     endpoint: "POST /mailboxes/v1/:mailbox_id/messages",          mcp: null,              cli: "email:reply",   openclaw: "email:reply" },

  // ── Mailbox webhooks ──────────────────────────────────────────────────
  { id: "register_mailbox_webhook", endpoint: "POST /mailboxes/v1/:mailbox_id/webhooks",              mcp: "register_mailbox_webhook", cli: "webhooks:register", openclaw: "webhooks:register" },
  { id: "list_mailbox_webhooks",    endpoint: "GET /mailboxes/v1/:mailbox_id/webhooks",               mcp: "list_mailbox_webhooks",    cli: "webhooks:list",     openclaw: "webhooks:list" },
  { id: "get_mailbox_webhook",      endpoint: "GET /mailboxes/v1/:mailbox_id/webhooks/:webhook_id",   mcp: "get_mailbox_webhook",      cli: "webhooks:get",      openclaw: "webhooks:get" },
  { id: "delete_mailbox_webhook",   endpoint: "DELETE /mailboxes/v1/:mailbox_id/webhooks/:webhook_id", mcp: "delete_mailbox_webhook",  cli: "webhooks:delete",   openclaw: "webhooks:delete" },
  { id: "update_mailbox_webhook",   endpoint: "PATCH /mailboxes/v1/:mailbox_id/webhooks/:webhook_id", mcp: "update_mailbox_webhook",   cli: "webhooks:update",   openclaw: "webhooks:update" },
  { id: "list_mailbox_webhook_deliveries", endpoint: "GET /mailboxes/v1/:mailbox_id/webhooks/deliveries", mcp: "list_mailbox_webhook_deliveries", cli: "webhooks:deliveries", openclaw: "webhooks:deliveries" },
  { id: "redrive_mailbox_webhook_delivery", endpoint: "POST /mailboxes/v1/:mailbox_id/webhooks/deliveries/:delivery_id/redrive", mcp: "redrive_mailbox_webhook_delivery", cli: "webhooks:redrive", openclaw: "webhooks:redrive" },

  // ── AI ──────────────────────────────────────────────────────────────────
  { id: "ai_translate",    endpoint: "POST /ai/v1/translate",      mcp: "ai_translate",    cli: "ai:translate",  openclaw: "ai:translate" },
  { id: "ai_moderate",     endpoint: "POST /ai/v1/moderate",       mcp: "ai_moderate",     cli: "ai:moderate",   openclaw: "ai:moderate" },
  { id: "ai_usage",        endpoint: "GET /ai/v1/usage",           mcp: "ai_usage",        cli: "ai:usage",      openclaw: "ai:usage" },

  // ── Messaging & agent contact ──────────────────────────────────────────
  { id: "send_message",      endpoint: "POST /message/v1",                  mcp: "send_message",        cli: "message:send",     openclaw: "message:send" },
  { id: "set_agent_contact", endpoint: "POST /agent/v1/contact",            mcp: "set_agent_contact",   cli: "agent:contact",    openclaw: "agent:contact" },
  { id: "get_agent_contact_status", endpoint: "GET /agent/v1/contact/status", mcp: "get_agent_contact_status", cli: "agent:status", openclaw: "agent:status" },
  { id: "verify_agent_contact_email", endpoint: "POST /agent/v1/contact/verify-email", mcp: "verify_agent_contact_email", cli: "agent:verify-email", openclaw: "agent:verify-email" },
  { id: "start_operator_passkey_enrollment", endpoint: "POST /agent/v1/contact/passkey/enroll", mcp: "start_operator_passkey_enrollment", cli: "agent:passkey", openclaw: "agent:passkey" },

  // ── Operator health notifications (v1.55) ──────────────────────────────
  { id: "get_operator_status",          endpoint: "GET /agent/v1/operator/status",                 mcp: "get_operator_status",          cli: null,                            openclaw: null },
  { id: "list_notifications",           endpoint: "GET /agent/v1/notifications",                   mcp: "list_notifications",           cli: "notifications:list",            openclaw: "notifications:list" },
  { id: "get_notification",             endpoint: "GET /agent/v1/notifications/:id",               mcp: null,                            cli: "notifications:get",             openclaw: "notifications:get" },
  { id: "get_notification_preferences", endpoint: "GET /agent/v1/notifications/preferences",       mcp: "get_notification_preferences", cli: "notifications:preferences",     openclaw: "notifications:preferences" },
  // CLI surfaces both get + set under one `notifications preferences` command
  // (positional `set k=v...`). MCP keeps the read and write as separate tools.
  { id: "set_notification_preferences", endpoint: "PATCH /agent/v1/notifications/preferences",     mcp: "set_notification_preferences", cli: null,                            openclaw: null },
  { id: "test_notification",            endpoint: "POST /agent/v1/notifications/test",             mcp: "test_notification",            cli: "notifications:test",            openclaw: "notifications:test" },
  { id: "rotate_webhook_secret",        endpoint: "POST /agent/v1/webhook-secret/rotate",          mcp: "rotate_webhook_secret",        cli: "webhook-secret:rotate",         openclaw: "webhook-secret:rotate" },

  // ── Operator session (human/email principal, RFC 8628 device-auth) ──────
  // The operator is the human (email), distinct from the agent (wallet/SIWX).
  // Human-only surface → MCP null by design (MCP authenticates as the agent;
  // the human device-login must not hand the email-union session to the agent).
  // The wallet's own account view is `run402 status`, not an operator command.
  { id: "operator_login",    endpoint: "POST /agent/v1/operator/session/device (+ /device/token)", mcp: null, cli: "operator:login",    openclaw: "operator:login" },
  { id: "operator_overview", endpoint: "GET /agent/v1/operator/overview (operator-session bearer)", mcp: null, cli: "operator:overview", openclaw: "operator:overview" },
  { id: "operator_logout",   endpoint: "POST /agent/v1/operator/session/revoke",                   mcp: null, cli: "operator:logout",   openclaw: "operator:logout" },
  { id: "operator_whoami",   endpoint: "(local)",                                                  mcp: null, cli: "operator:whoami",   openclaw: "operator:whoami" },
  { id: "claim_wallet_org",  endpoint: "POST /agent/v1/operator/claim-wallet-org (+ /challenge)",   mcp: null, cli: "operator:claim-wallet-org", openclaw: "operator:claim-wallet-org" },
  { id: "operator_approve",  endpoint: "POST /agent/v1/control-plane/write-auth/challenges (+ /cli/token)", mcp: null, cli: "operator:approve",  openclaw: "operator:approve" },
  { id: "operator_status",   endpoint: "(local)",                                                  mcp: null, cli: "operator:status",   openclaw: "operator:status" },

  // ── Additional billing ─────────────────────────────────────────────────
  { id: "create_checkout",   endpoint: "POST /orgs/v1/:org_id/checkouts",        mcp: "create_checkout",     cli: "billing:checkout",  openclaw: "billing:checkout" },
  { id: "allowance_checkout", endpoint: "POST /orgs/v1/:org_id/checkouts (local wallet convenience)", mcp: null, cli: "allowance:checkout", openclaw: "allowance:checkout" },
  { id: "billing_history",   endpoint: "GET /orgs/v1/:org_id/billing/history", mcp: "billing_history", cli: "allowance:history", openclaw: "allowance:history" },

  // ── Version management ─────────────────────────────────────────────────
  { id: "update_version",    endpoint: "PATCH /projects/v1/admin/:id/versions/:version_id", mcp: "update_version", cli: "apps:update", openclaw: "apps:update" },
  { id: "delete_version",    endpoint: "DELETE /projects/v1/admin/:id/versions/:version_id", mcp: "delete_version", cli: "apps:delete", openclaw: "apps:delete" },
  { id: "get_app",           endpoint: "GET /apps/v1/:version_id",          mcp: "get_app",             cli: "apps:inspect",     openclaw: "apps:inspect" },

  // ── Admin ──────────────────────────────────────────────────────────────
  // v1.57: pin/unpin endpoints removed. Per-project pin is superseded by the
  // organization-level escape hatch (admin_set_lease_perpetual). archive and
  // reactivate are operator moderation actions, scoped to a single project.
  { id: "admin_set_lease_perpetual", endpoint: "POST /orgs/v1/admin/:org_id/lease-perpetual", mcp: "admin_set_lease_perpetual", cli: "admin:lease-perpetual", openclaw: "admin:lease-perpetual" },
  { id: "admin_archive_project",     endpoint: "POST /projects/v1/admin/:id/archive",                 mcp: "admin_archive_project",     cli: "admin:archive",          openclaw: "admin:archive" },
  { id: "admin_reactivate_project",  endpoint: "POST /projects/v1/admin/:id/reactivate",              mcp: "admin_reactivate_project",  cli: "admin:reactivate",       openclaw: "admin:reactivate" },
  { id: "promote_user",    endpoint: "POST /projects/v1/admin/:id/promote-user", mcp: "promote_user", cli: "projects:promote-user", openclaw: "projects:promote-user" },
  { id: "demote_user",     endpoint: "POST /projects/v1/admin/:id/demote-user",  mcp: "demote_user",  cli: "projects:demote-user",  openclaw: "projects:demote-user" },
  { id: "admin_project_finance", endpoint: "GET /admin/api/finance/project/:id", mcp: null, cli: "projects:costs", openclaw: "projects:costs" },

  // ── Project transfer (unified noun) — wallet (accept) + email (claim) + owned-org (immediate) ──
  { id: "initiate_project_transfer", endpoint: "POST /projects/v1/:project_id/transfers",       mcp: "initiate_project_transfer", cli: "transfer:init",    openclaw: "transfer:init" },
  { id: "preview_project_transfer",  endpoint: "GET /agent/v1/transfers/:transfer_id",          mcp: "preview_project_transfer",  cli: "transfer:preview", openclaw: "transfer:preview" },
  { id: "accept_project_transfer",   endpoint: "POST /agent/v1/transfers/:transfer_id/accept",  mcp: "accept_project_transfer",   cli: "transfer:accept",  openclaw: "transfer:accept" },
  { id: "claim_project_transfer",    endpoint: "POST /agent/v1/transfers/:transfer_id/claim",   mcp: "claim_project_transfer",    cli: "transfer:claim",   openclaw: "transfer:claim" },
  { id: "cancel_project_transfer",   endpoint: "POST /agent/v1/transfers/:transfer_id/cancel",  mcp: "cancel_project_transfer",   cli: "transfer:cancel",  openclaw: "transfer:cancel" },
  { id: "list_incoming_transfers",   endpoint: "GET /agent/v1/transfers/incoming",              mcp: "list_incoming_transfers",   cli: "transfer:list",    openclaw: "transfer:list" },
  { id: "list_outgoing_transfers",   endpoint: "GET /agent/v1/transfers/outgoing",              mcp: "list_outgoing_transfers",   cli: null,               openclaw: null },

  // ── Org-owned control plane: identity, membership, grants (v1.77+) ──────
  { id: "create_org",          endpoint: "POST /orgs/v1",                                 mcp: "create_org",            cli: "org:create",        openclaw: "org:create" },
  { id: "get_org",             endpoint: "GET /orgs/v1/:org_id",                          mcp: "get_org",               cli: "org:get",           openclaw: "org:get" },
  { id: "rename_org",          endpoint: "PATCH /orgs/v1/:org_id",                        mcp: "rename_org",            cli: "org:rename",        openclaw: "org:rename" },
  { id: "whoami",              endpoint: "GET /agent/v1/whoami",                          mcp: "whoami",                cli: "org:whoami",        openclaw: "org:whoami" },
  { id: "list_orgs",           endpoint: "GET /orgs/v1",                                  mcp: "list_orgs",             cli: "org:list",          openclaw: "org:list" },
  { id: "list_org_members",    endpoint: "GET /orgs/v1/:org_id/members",                      mcp: "list_org_members",      cli: "org:member:list",   openclaw: "org:member:list" },
  { id: "add_org_member",      endpoint: "POST /orgs/v1/:org_id/members",                     mcp: "add_org_member",        cli: "org:member:add",    openclaw: "org:member:add" },
  { id: "set_org_member_role", endpoint: "PATCH /orgs/v1/:org_id/members/:principal_id",      mcp: "set_org_member_role",   cli: "org:member:role",   openclaw: "org:member:role" },
  { id: "remove_org_member",   endpoint: "DELETE /orgs/v1/:org_id/members/:principal_id",     mcp: "remove_org_member",     cli: "org:member:rm",     openclaw: "org:member:rm" },
  { id: "org_audit",           endpoint: "GET /orgs/v1/:org_id/audit",                        mcp: null,                    cli: "org:audit",         openclaw: "org:audit" },
  { id: "org_invite_list",     endpoint: "GET /orgs/v1/:org_id/invites",                      mcp: null,                    cli: "org:invite:list",   openclaw: "org:invite:list" },
  { id: "org_invite_create",   endpoint: "POST /orgs/v1/:org_id/invites",                     mcp: null,                    cli: "org:invite:create", openclaw: "org:invite:create" },
  { id: "org_invite_rm",       endpoint: "DELETE /orgs/v1/:org_id/invites/:principal_id",     mcp: null,                    cli: "org:invite:rm",     openclaw: "org:invite:rm" },
  { id: "create_project_grant", endpoint: "POST /projects/v1/:id/grants",                 mcp: "create_project_grant",  cli: "grants:create",     openclaw: "grants:create" },
  { id: "revoke_project_grant", endpoint: "DELETE /projects/v1/:id/grants/:grant_id",     mcp: "revoke_project_grant",  cli: "grants:revoke",     openclaw: "grants:revoke" },

  // ── Auth (project user) ────────────────────────────────────────────────
  { id: "request_magic_link", endpoint: "POST /auth/v1/magic-link",           mcp: "request_magic_link", cli: "auth:magic-link",    openclaw: "auth:magic-link" },
  { id: "verify_magic_link",  endpoint: "POST /auth/v1/token?grant_type=magic_link", mcp: "verify_magic_link", cli: "auth:verify", openclaw: "auth:verify" },
  { id: "create_auth_user",   endpoint: "POST /auth/v1/admin/users",          mcp: "create_auth_user",   cli: "auth:create-user",  openclaw: "auth:create-user" },
  { id: "invite_auth_user",   endpoint: "POST /auth/v1/admin/users",          mcp: "invite_auth_user",   cli: "auth:invite-user",  openclaw: "auth:invite-user" },
  { id: "set_user_password",  endpoint: "PUT /auth/v1/user/password",         mcp: "set_user_password",  cli: "auth:set-password",  openclaw: "auth:set-password" },
  { id: "auth_settings",      endpoint: "PATCH /auth/v1/settings",            mcp: "auth_settings",      cli: "auth:settings",      openclaw: "auth:settings" },
  { id: "passkey_register_options", endpoint: "POST /auth/v1/passkeys/register/options", mcp: "passkey_register_options", cli: "auth:passkey-register-options", openclaw: "auth:passkey-register-options" },
  { id: "passkey_register_verify",  endpoint: "POST /auth/v1/passkeys/register/verify",  mcp: "passkey_register_verify",  cli: "auth:passkey-register-verify",  openclaw: "auth:passkey-register-verify" },
  { id: "passkey_login_options",    endpoint: "POST /auth/v1/passkeys/login/options",    mcp: "passkey_login_options",    cli: "auth:passkey-login-options",    openclaw: "auth:passkey-login-options" },
  { id: "passkey_login_verify",     endpoint: "POST /auth/v1/passkeys/login/verify",     mcp: "passkey_login_verify",     cli: "auth:passkey-login-verify",     openclaw: "auth:passkey-login-verify" },
  { id: "list_passkeys",            endpoint: "GET /auth/v1/passkeys",                   mcp: "list_passkeys",            cli: "auth:passkeys",                 openclaw: "auth:passkeys" },
  { id: "delete_passkey",           endpoint: "DELETE /auth/v1/passkeys/:id",             mcp: "delete_passkey",           cli: "auth:delete-passkey",           openclaw: "auth:delete-passkey" },
  { id: "auth_providers",    endpoint: "GET /auth/v1/providers",              mcp: null,                 cli: "auth:providers",     openclaw: "auth:providers" },
  { id: "auth_scaffold_roles", endpoint: "(local)",                           mcp: "scaffold_roles",     cli: "auth:scaffold-roles", openclaw: "auth:scaffold-roles" },

  // ── Custom sender domains ─────────────────────────────────────────────
  { id: "register_sender_domain", endpoint: "POST /email/v1/domains",    mcp: "register_sender_domain", cli: "sender-domain:register", openclaw: "sender-domain:register" },
  { id: "sender_domain_status",  endpoint: "GET /email/v1/domains",     mcp: "sender_domain_status",  cli: "sender-domain:status",   openclaw: "sender-domain:status" },
  { id: "remove_sender_domain",  endpoint: "DELETE /email/v1/domains",  mcp: "remove_sender_domain",  cli: "sender-domain:remove",   openclaw: "sender-domain:remove" },
  { id: "enable_sender_domain_inbound",  endpoint: "POST /email/v1/domains/inbound",   mcp: "enable_sender_domain_inbound",  cli: "sender-domain:inbound-enable",  openclaw: "sender-domain:inbound-enable" },
  { id: "disable_sender_domain_inbound", endpoint: "DELETE /email/v1/domains/inbound", mcp: "disable_sender_domain_inbound", cli: "sender-domain:inbound-disable", openclaw: "sender-domain:inbound-disable" },

  // ── Email organizations + org checkout ─────────────────────────────
  { id: "create_email_organization", endpoint: "POST /orgs/v1/email",                   mcp: "create_email_organization", cli: "billing:create-email",   openclaw: "billing:create-email" },
  { id: "link_wallet_to_organization",       endpoint: "POST /orgs/v1/:org_id/wallets",   mcp: "link_wallet_to_organization",       cli: "billing:link-wallet",    openclaw: "billing:link-wallet" },
  { id: "set_auto_recharge",            endpoint: "PATCH /orgs/v1/:org_id/billing/auto-recharge",  mcp: "set_auto_recharge",            cli: "billing:auto-recharge",  openclaw: "billing:auto-recharge" },
  { id: "billing_balance",              endpoint: "GET /orgs/v1/:org_id/billing",        mcp: null,                           cli: "billing:balance",        openclaw: "billing:balance" },
  { id: "billing_history_cli",          endpoint: "GET /orgs/v1/:org_id/billing/history",        mcp: null,                           cli: "billing:history",        openclaw: "billing:history" },

  // ── Tier management ────────────────────────────────────────────────────
  { id: "tier_status",       endpoint: "GET /tiers/v1/status",             mcp: "tier_status",      cli: "tier:status",      openclaw: "tier:status" },

  // ── Allowance management ───────────────────────────────────────────────
  { id: "allowance_status",  endpoint: "(local)",                          mcp: "allowance_status", cli: "allowance:status", openclaw: "allowance:status" },
  { id: "allowance_create",  endpoint: "(local)",                          mcp: "allowance_create", cli: "allowance:create", openclaw: "allowance:create" },
  { id: "allowance_export",  endpoint: "(local)",                          mcp: "allowance_export", cli: "allowance:export", openclaw: "allowance:export" },

  // ── Service status (public, unauthenticated) ───────────────────────────
  { id: "service_status",    endpoint: "GET /status",                      mcp: "service_status",   cli: "service:status",   openclaw: "service:status" },
  { id: "service_health",    endpoint: "GET /health",                      mcp: "service_health",   cli: "service:health",   openclaw: "service:health" },

  // ── KMS signers ─────────────────────────────────────────────────────────
  { id: "provision_signer",          endpoint: "POST /contracts/v1/signers",                       mcp: "provision_signer",          cli: "contracts:provision-signer", openclaw: "contracts:provision-signer" },
  { id: "get_signer",                endpoint: "GET /contracts/v1/signers/:id",                    mcp: "get_signer",                cli: "contracts:get-signer",       openclaw: "contracts:get-signer" },
  { id: "list_signers",              endpoint: "GET /contracts/v1/signers",                        mcp: "list_signers",              cli: "contracts:list-signers",     openclaw: "contracts:list-signers" },
  { id: "set_recovery_address",      endpoint: "POST /contracts/v1/signers/:id/recovery-address",  mcp: "set_recovery_address",      cli: "contracts:set-recovery",     openclaw: "contracts:set-recovery" },
  { id: "set_low_balance_alert",     endpoint: "POST /contracts/v1/signers/:id/alert",             mcp: "set_low_balance_alert",     cli: "contracts:set-alert",        openclaw: "contracts:set-alert" },
  { id: "contract_call",             endpoint: "POST /contracts/v1/call",                          mcp: "contract_call",             cli: "contracts:call",             openclaw: "contracts:call" },
  { id: "contract_deploy",           endpoint: "POST /contracts/v1/deploy",                        mcp: "contract_deploy",           cli: "contracts:deploy",           openclaw: "contracts:deploy" },
  { id: "contract_read",             endpoint: "POST /contracts/v1/read",                          mcp: "contract_read",             cli: "contracts:read",             openclaw: "contracts:read" },
  { id: "get_contract_call_status",  endpoint: "GET /contracts/v1/calls/:id",                      mcp: "get_contract_call_status",  cli: "contracts:status",           openclaw: "contracts:status" },
  { id: "drain_signer",              endpoint: "POST /contracts/v1/signers/:id/drain",             mcp: "drain_signer",              cli: "contracts:drain",            openclaw: "contracts:drain" },
  { id: "delete_signer",             endpoint: "DELETE /contracts/v1/signers/:id",                 mcp: "delete_signer",             cli: "contracts:delete",           openclaw: "contracts:delete" },
];

// ─── SDK namespace mapping ──────────────────────────────────────────────────
// Each SURFACE capability that has an MCP/CLI implementation should map to
// an SDK method path `"namespace.method"`. Capabilities that are intentionally
// not on the SDK map to null.
//
// When you add a new capability to SURFACE that ships an SDK method, also
// add the id → path mapping here. The tests below enforce both sides.

const SDK_BY_CAPABILITY: Record<string, string | null> = {
  // Local-only compound flows — MCP handlers compose SDK calls internally.
  up: "actions.up",
  init: null,
  status: null,

  // Named wallets — local profile management (no SDK gateway method).
  wallets_list: null,
  wallets_current: null,
  wallets_new: null,
  wallets_use: null,
  wallets_rename: null,
  wallets_bind: null,
  wallets_unbind: null,
  wallets_import: null,
  wallets_rm: null,

  // SSR Runtime DX (v1.52) — local/CLI-only; no MCP, no SDK
  doctor: null,
  dev: null,
  logs: null,

  // SSR origin cache (v1.52)
  cache_invalidate: "cache.invalidate",
  cache_inspect: "cache.inspect",

  // Project lifecycle
  get_quote: "projects.getQuote",
  provision: "projects.provision",
  set_tier: "tier.set",
  delete: "projects.delete",
  export_project_archive: "archives.export",
  download_project_archive: "archives.download",
  get_project_archive: "archives.get",
  inspect_project_archive: "archives.inspect",
  verify_project_archive: "archives.verify",
  import_project_archive: "archives.importToCore",
  faucet: "allowance.faucet",

  // Database / Admin
  run_sql: "projects.sql",
  rest_query: "projects.rest",
  apply_expose: "projects.applyExpose",
  validate_manifest: "projects.validateExpose",
  get_expose: "projects.getExpose",
  get_schema: "projects.getSchema",
  get_usage: "projects.getUsage",

  // Assets (direct-to-S3, v1.48 unified-apply rename of blobs)
  assets_put: "assets.put",
  assets_get: "assets.get",
  assets_ls: "assets.ls",
  assets_rm: "assets.rm",
  assets_sign: "assets.sign",
  // v1.45: agent-DX CDN diagnostics for asset URLs
  diagnose_public_url: "assets.diagnoseUrl",
  wait_for_cdn_freshness: "assets.waitFresh",

  // Functions
  deploy_function: "functions.deploy",
  invoke_function: "functions.invoke",
  get_function_logs: "functions.logs",
  list_functions: "functions.list",
  delete_function: "functions.delete",
  update_function: "functions.update",
  rebuild_function: "functions.rebuild",
  create_function_run: "functions.runs.create",
  list_function_runs: "functions.runs.list",
  get_function_run: "functions.runs.get",
  get_function_run_logs: "functions.runs.logs",
  cancel_function_run: "functions.runs.cancel",
  redrive_function_run: "functions.runs.redrive",

  // Secrets
  set_secret: "secrets.set",
  list_secrets: "secrets.list",
  delete_secret: "secrets.delete",

  // Managed jobs
  jobs_submit: "jobs.submit",
  jobs_get: "jobs.get",
  jobs_logs: "jobs.logs",
  jobs_cancel: "jobs.cancel",
  jobs_purge: "jobs.purge",
  jobs_download_artifact: "jobs.downloadArtifact",

  // Sites / Subdomains
  deploy_site: null, // MCP stages files to a temp dir and composes deployDir
  deploy_site_dir: "sites.deployDir", // Node-only SDK helper: walks fs + unified deploy primitive
  claim_subdomain: "subdomains.claim",
  delete_subdomain: "subdomains.delete",
  list_subdomains: "subdomains.list",

  // Custom domains
  add_custom_domain: "domains.add",
  list_custom_domains: "domains.list",
  check_domain_status: "domains.status",
  remove_custom_domain: "domains.remove",

  // Unified apply. The engine lives
  // at r._applyEngine internally; the public hero is r.project(id).apply.
  // SDK_BY_CAPABILITY targets the engine instance for resolution checks.
  deploy: "_applyEngine.apply",
  deploy_promote: "_applyEngine.promote",
  deploy_resume: "_applyEngine.resume",
  deploy_list: "_applyEngine.list",
  deploy_events: "_applyEngine.events",
  deploy_release_get: "_applyEngine.getRelease",
  deploy_release_active: "_applyEngine.getActiveRelease",
  deploy_release_diff: "_applyEngine.diff",
  deploy_diagnose_url: "_applyEngine.resolve",
  deploy_resolve: "_applyEngine.resolve",
  ci_link_github: "ci.createBinding",
  ci_list_bindings: "ci.listBindings",
  ci_get_binding: "ci.getBinding",
  ci_revoke_binding: "ci.revokeBinding",
  ci_set_asset_scopes: "ci.setAssetKeyScopes",

  // Marketplace
  browse_apps: "apps.browse",
  fork_app: "apps.fork",
  publish_app: "apps.publish",
  list_versions: "apps.listVersions",
  update_version: "apps.updateVersion",
  delete_version: "apps.deleteVersion",
  get_app: "apps.getApp",

  // Billing
  check_balance: "billing.checkBalance",
  list_projects: "projects.list",
  rename_project: "projects.rename",
  project_get: "projects.get",
  project_info: "projects.info",
  project_use: "projects.use",
  project_keys: "projects.keys",
  create_checkout: "billing.createCheckout",
  allowance_checkout: "billing.createCheckout",
  billing_history: "billing.history",
  create_email_organization: "billing.createEmailOrganization",
  link_wallet_to_organization: "billing.linkWallet",
  set_auto_recharge: "billing.setAutoRecharge",
  billing_balance: "billing.getOrganization",
  billing_history_cli: "billing.getHistory",

  // Image / AI
  generate_image: "ai.generateImage",
  ai_translate: "ai.translate",
  ai_moderate: "ai.moderate",
  ai_usage: "ai.usage",

  // Email
  create_mailbox: "email.createMailbox",
  list_mailboxes: "email.listMailboxes",
  set_mailbox_defaults: "email.setMailboxDefaults",
  update_mailbox: "email.updateMailbox",
  send_email: "email.send",
  list_emails: "email.list",
  get_email: "email.get",
  get_email_raw: "email.getRaw",
  get_mailbox: "email.getMailbox",
  delete_mailbox: "email.deleteMailbox",
  reply_email: null, // CLI compound flow (email.get + email.send in sequence)

  // Mailbox webhooks
  register_mailbox_webhook: "email.webhooks.register",
  list_mailbox_webhooks: "email.webhooks.list",
  get_mailbox_webhook: "email.webhooks.get",
  delete_mailbox_webhook: "email.webhooks.delete",
  update_mailbox_webhook: "email.webhooks.update",
  list_mailbox_webhook_deliveries: "email.webhooks.listDeliveries",
  redrive_mailbox_webhook_delivery: "email.webhooks.redriveDelivery",

  // Messaging & agent contact
  send_message: "admin.sendMessage",
  set_agent_contact: "admin.setAgentContact",
  get_agent_contact_status: "admin.getAgentContactStatus",
  verify_agent_contact_email: "admin.verifyAgentContactEmail",

  // Operator health notifications (v1.55)
  get_operator_status: "admin.getOperatorStatus",
  list_notifications: "admin.listNotifications",
  get_notification: "admin.getNotification",
  get_notification_preferences: "admin.getNotificationPreferences",
  set_notification_preferences: "admin.setNotificationPreferences",
  test_notification: "admin.testNotification",
  rotate_webhook_secret: "admin.rotateWebhookSecret",
  start_operator_passkey_enrollment: "admin.startOperatorPasskeyEnrollment",

  // Operator session (human/email, RFC 8628 device-auth). `operator login`
  // brokers deviceStart + devicePoll; devicePoll has no dedicated capability
  // (it shares the `login` verb) and is listed in SDK_ONLY_METHODS below.
  operator_login: "operator.deviceStart",
  operator_overview: "operator.overview",
  operator_logout: "operator.revoke",
  operator_whoami: null, // local-only cache read (core/operator-session.ts)
  // Claim maps to the submit step; the challenge step is in SDK_ONLY_METHODS and
  // the full dance is the Node convenience `claimWalletOrg` (a standalone export).
  claim_wallet_org: "operator.claimWalletOrg.submit",
  operator_approve: "operator.approval.requestChallenge",
  operator_status: null, // local-only cache read (core/write-auth-session.ts)

  // Admin (v1.57)
  admin_set_lease_perpetual: "admin.setLeasePerpetual",
  admin_archive_project: "admin.archiveProject",
  admin_reactivate_project: "admin.reactivateProject",
  promote_user: "auth.promote",
  demote_user: "auth.demote",
  admin_project_finance: "admin.getProjectFinance",

  // Project transfer (unified noun) — sub-namespace lives on admin.transfers
  initiate_project_transfer: "admin.transfers.initiate",
  preview_project_transfer: "admin.transfers.preview",
  accept_project_transfer: "admin.transfers.accept",
  claim_project_transfer: "admin.transfers.claim",
  cancel_project_transfer: "admin.transfers.cancel",
  list_incoming_transfers: "admin.transfers.listIncoming",
  list_outgoing_transfers: "admin.transfers.listOutgoing",

  // Org-owned control plane (v1.77+) — r.org.* + r.grants.*
  create_org: "orgs.create",
  get_org: "org.get",
  rename_org: "org.rename",
  whoami: "orgs.whoami",
  list_orgs: "orgs.list",
  list_org_members: "org.members.list",
  add_org_member: "org.members.add",
  set_org_member_role: "org.members.setRole",
  remove_org_member: "org.members.revoke",
  org_audit: "org.audit",
  org_invite_list: "org.invites.list",
  org_invite_create: "org.invites.create",
  org_invite_rm: "org.invites.revoke",
  create_project_grant: "grants.create",
  revoke_project_grant: "grants.revoke",

  // Auth
  request_magic_link: "auth.requestMagicLink",
  verify_magic_link: "auth.verifyMagicLink",
  create_auth_user: "auth.createUser",
  invite_auth_user: "auth.inviteUser",
  set_user_password: "auth.setUserPassword",
  auth_settings: "auth.settings",
  passkey_register_options: "auth.createPasskeyRegistrationOptions",
  passkey_register_verify: "auth.verifyPasskeyRegistration",
  passkey_login_options: "auth.createPasskeyLoginOptions",
  passkey_login_verify: "auth.verifyPasskeyLogin",
  list_passkeys: "auth.listPasskeys",
  delete_passkey: "auth.deletePasskey",
  auth_providers: "auth.providers",
  auth_scaffold_roles: null, // offline CLI/MCP generator — no SDK method

  // Sender domains
  register_sender_domain: "senderDomain.register",
  sender_domain_status: "senderDomain.status",
  remove_sender_domain: "senderDomain.remove",
  enable_sender_domain_inbound: "senderDomain.enableInbound",
  disable_sender_domain_inbound: "senderDomain.disableInbound",

  // Tier
  tier_status: "tier.status",

  // Allowance (local-managed via Node provider)
  allowance_status: "allowance.status",
  allowance_create: "allowance.create",
  allowance_export: "allowance.export",

  // Service
  service_status: "service.status",
  service_health: "service.health",

  // KMS contract wallets
  provision_signer: "contracts.provisionSigner",
  get_signer: "contracts.getSigner",
  list_signers: "contracts.listSigners",
  set_recovery_address: "contracts.setRecovery",
  set_low_balance_alert: "contracts.setLowBalanceAlert",
  contract_call: "contracts.call",
  contract_deploy: "contracts.deploy",
  contract_read: "contracts.read",
  get_contract_call_status: "contracts.callStatus",
  drain_signer: "contracts.drain",
  delete_signer: "contracts.deleteSigner",
};

/** Walk the SDK `Run402` class and list every namespace.method pair (including nested email.webhooks.*). */
async function listSdkMethods(): Promise<string[]> {
  // Dynamic import of the built SDK. Build runs before tests via npm run build.
  const sdkModule = await import("./sdk/dist/index.js");
  const Run402 = (sdkModule as { Run402: new (opts: unknown) => unknown }).Run402;
  // Construct with a stub provider so method discovery works without network or FS.
  const stub = {
    async getAuth() { return null; },
    async getProject() { return null; },
  };
  const instance = new Run402({
    apiBase: "https://invalid.example",
    credentials: stub,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const methods: string[] = [];
  for (const ns of Object.keys(instance)) {
    const namespaceObj = instance[ns];
    if (!namespaceObj || typeof namespaceObj !== "object") continue;
    // Top-level methods on the namespace class prototype.
    const proto = Object.getPrototypeOf(namespaceObj);
    if (!proto) continue;
    if (proto === Object.prototype) {
      for (const name of Object.keys(namespaceObj)) {
        if (typeof namespaceObj[name] !== "function") continue;
        methods.push(`${ns}.${name}`);
      }
      continue;
    }
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      if (typeof proto[name] !== "function") continue;
      methods.push(`${ns}.${name}`);
    }
    // Nested sub-namespaces (e.g. email.webhooks). Skip internal fields like
    // `client` whose prototype is plain Object.
    for (const inner of Object.keys(namespaceObj)) {
      const innerObj = namespaceObj[inner];
      if (!innerObj || typeof innerObj !== "object") continue;
      const innerProto = Object.getPrototypeOf(innerObj);
      // Only walk objects that have a real class prototype (not Object.prototype).
      if (!innerProto || innerProto === Object.prototype) continue;
      for (const name of Object.getOwnPropertyNames(innerProto)) {
        if (name === "constructor") continue;
        if (typeof innerProto[name] !== "function") continue;
        methods.push(`${ns}.${inner}.${name}`);
      }
    }
  }

  // Node-only augmentations (methods that live in @run402/sdk/node but not in
  // the isomorphic entry). These are added to a namespace at factory time —
  // e.g. NodeSites adds deployDir on top of Sites. Walk their class
  // prototypes directly and expose them as "namespace.method" so they can be
  // referenced from SDK_BY_CAPABILITY like any other method.
  // Also covers classes that are NOT walkable from the instance: the org
  // instance methods live on `r.org(id)` (a callable, not an enumerable
  // object), so ScopedOrg/OrgMembers/OrgInvites prototypes are registered here
  // under the `org` / `org.members` / `org.invites` path prefixes.
  const nodeAugments: Array<{ namespace: string; modulePath: string; exportName: string }> = [
    { namespace: "sites", modulePath: "./sdk/dist/node/sites-node.js", exportName: "NodeSites" },
    { namespace: "archives", modulePath: "./sdk/dist/node/archives-node.js", exportName: "NodeArchives" },
    { namespace: "actions", modulePath: "./sdk/dist/node/actions-node.js", exportName: "NodeActions" },
    { namespace: "org", modulePath: "./sdk/dist/index.js", exportName: "ScopedOrg" },
    { namespace: "org.members", modulePath: "./sdk/dist/index.js", exportName: "OrgMembers" },
    { namespace: "org.invites", modulePath: "./sdk/dist/index.js", exportName: "OrgInvites" },
  ];
  for (const aug of nodeAugments) {
    const mod = (await import(aug.modulePath)) as Record<string, unknown>;
    const ctor = mod[aug.exportName] as { prototype: Record<string, unknown> } | undefined;
    if (!ctor) continue;
    for (const name of Object.getOwnPropertyNames(ctor.prototype)) {
      if (name === "constructor") continue;
      if (typeof ctor.prototype[name] !== "function") continue;
      const path = `${aug.namespace}.${name}`;
      if (!methods.includes(path)) methods.push(path);
    }
  }

  return methods.sort();
}

// ─── Derived expected sets ───────────────────────────────────────────────────

const EXPECTED_MCP_TOOLS = SURFACE
  .map(c => c.mcp)
  .filter((t): t is string => t !== null)
  .sort();

const EXPECTED_CLI_COMMANDS = SURFACE
  .map(c => c.cli)
  .filter((t): t is string => t !== null)
  .sort();

const EXPECTED_OPENCLAW_COMMANDS = SURFACE
  .map(c => c.openclaw)
  .filter((t): t is string => t !== null)
  .sort();

// CLI dispatch-through commands that are routing prefixes, not leaf commands.
// The scanner finds them as case statements but they just delegate to sub-modules.
const CLI_DISPATCH_COMMANDS = ["email:webhooks", "deploy:release", "cloud:archives", "core:projects"];

// CLI aliases that route to the same handler as a primary command already in
// SURFACE. Listed here so the "no untracked commands" check doesn't fail.
// Primary name is what appears in SURFACE; the alias is kept for backward compat.
const CLI_ALIAS_COMMANDS = ["email:status"]; // alias of email:info

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("MCP tool inventory", () => {
  const actual = parseMcpTools();

  it("has all expected tools", () => {
    const missing = EXPECTED_MCP_TOOLS.filter(t => !actual.includes(t));
    assert.deepEqual(
      missing,
      [],
      `MCP is missing tools. Either implement them in src/tools/ and register in src/index.ts, ` +
        `or remove from SURFACE in sync.test.ts: ${missing.join(", ")}`,
    );
  });

  it("has no untracked tools", () => {
    const unexpected = actual.filter(t => !EXPECTED_MCP_TOOLS.includes(t));
    assert.deepEqual(
      unexpected,
      [],
      `MCP has tools not in SURFACE. Add them to sync.test.ts: ${unexpected.join(", ")}`,
    );
  });
});

describe("CLI command inventory", () => {
  const actual = parseCliCommands();

  it("has all expected commands", () => {
    const missing = EXPECTED_CLI_COMMANDS.filter(c => !actual.includes(c));
    assert.deepEqual(
      missing,
      [],
      `CLI is missing commands. Either implement in cli/lib/ or remove from SURFACE: ${missing.join(", ")}`,
    );
  });

  it("has no untracked commands", () => {
    const unexpected = actual.filter(c => !EXPECTED_CLI_COMMANDS.includes(c) && !CLI_DISPATCH_COMMANDS.includes(c) && !CLI_ALIAS_COMMANDS.includes(c));
    assert.deepEqual(
      unexpected,
      [],
      `CLI has commands not in SURFACE. Add them to sync.test.ts: ${unexpected.join(", ")}`,
    );
  });
});

describe("OpenClaw command inventory", () => {
  const actual = parseOpenClawCommands();

  it("has all expected commands", () => {
    const missing = EXPECTED_OPENCLAW_COMMANDS.filter(c => !actual.includes(c));
    assert.deepEqual(
      missing,
      [],
      `OpenClaw is missing commands. Either implement in openclaw/scripts/ or remove from SURFACE: ${missing.join(", ")}`,
    );
  });

  it("has no untracked commands", () => {
    const unexpected = actual.filter(c => !EXPECTED_OPENCLAW_COMMANDS.includes(c) && !CLI_DISPATCH_COMMANDS.includes(c) && !CLI_ALIAS_COMMANDS.includes(c));
    assert.deepEqual(
      unexpected,
      [],
      `OpenClaw has commands not in SURFACE. Add them to sync.test.ts: ${unexpected.join(", ")}`,
    );
  });
});

describe("CLI ↔ OpenClaw parity", () => {
  it("have identical command sets", () => {
    const cli = parseCliCommands();
    const openclaw = parseOpenClawCommands();
    assert.deepEqual(
      cli,
      openclaw,
      "CLI and OpenClaw must have the same commands. " +
        `CLI-only: [${cli.filter(c => !openclaw.includes(c)).join(", ")}], ` +
        `OpenClaw-only: [${openclaw.filter(c => !cli.includes(c)).join(", ")}]`,
    );
  });

  it("SURFACE declares same cli and openclaw for each capability", () => {
    const mismatches = SURFACE.filter(
      c => (c.cli === null) !== (c.openclaw === null) || c.cli !== c.openclaw,
    );
    assert.deepEqual(
      mismatches.map(c => c.id),
      [],
      "Every SURFACE entry must have identical cli and openclaw values (or both null). " +
        `Mismatches: ${mismatches.map(c => `${c.id}: cli=${c.cli}, openclaw=${c.openclaw}`).join("; ")}`,
    );
  });
});

describe("SDK surface alignment", () => {
  it("every SURFACE capability has an SDK mapping (or explicit null)", () => {
    const missing = SURFACE
      .map((c) => c.id)
      .filter((id) => !(id in SDK_BY_CAPABILITY));
    assert.deepEqual(
      missing,
      [],
      `Add these capabilities to SDK_BY_CAPABILITY (either \`"namespace.method"\` or \`null\` if intentionally not on the SDK): ${missing.join(", ")}`,
    );
  });

  it("every non-null SDK mapping resolves to a real SDK method", async () => {
    const sdkMethods = new Set(await listSdkMethods());
    const missing: string[] = [];
    for (const [id, path] of Object.entries(SDK_BY_CAPABILITY)) {
      if (path !== null && !sdkMethods.has(path)) {
        missing.push(`${id} → ${path}`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `SDK methods referenced in SDK_BY_CAPABILITY but missing from the built SDK: ${missing.join(", ")}`,
    );
  });

  it("every SDK method is referenced by some SURFACE mapping", async () => {
    // SDK-internal helpers that don't have a corresponding MCP/CLI entry.
    // Private in TypeScript but enumerable at runtime (TS `private` isn't
    // runtime-enforced), plus convenience methods consumers can compose
    // without needing their own MCP tool.
    const SDK_ONLY_METHODS = new Set([
      // Claim challenge is the first step of the claim-wallet-org flow; the
      // `claim_wallet_org` capability maps to the submit step, and the Node
      // convenience `claimWalletOrg` composes challenge + sign + submit.
      "operator.claimWalletOrg.challenge",
      "email.resolveMailbox",  // private helper
      "email.listMailboxEnvelope", // private helper
      "email.pickMailbox",     // private helper
      "email.pickDefaultOutboundMailbox", // private helper
      "email.cacheMailbox",    // private helper
      // billing.lookupOrganization resolves a wallet/email → org_id via
      // GET /orgs/v1/lookup?wallet=|?email=. It's an SDK primitive used by
      // getAccount/getHistory and exposed for consumers that only need the id;
      // no dedicated MCP/CLI verb (the wallet/email-keyed balance/history
      // commands resolve internally).
      "billing.lookupOrganization",
      "projects.active",       // returns active project id from the provider
      "projects.restResponse", // REST proxy with HTTP status for CLI/MCP formatters
      "assets.initUploadSession", // low-level resumable upload primitive for CLI UX
      "assets.getUploadSession", // low-level resumable upload primitive for CLI UX
      "assets.completeUploadSession", // low-level resumable upload primitive for CLI UX
      // ─── unified-apply (v1.48) ──────────────────────────────────────────
      // The hero is r.project(id).apply(spec). The engine lives at
      // r._applyEngine; the methods below are advanced primitives used by
      // the hero implementation (and by tests). The deploy/deploy_resume
      // MCP tools wrap r._applyEngine.apply / r._applyEngine.resume.
      "_applyEngine.start",
      "_applyEngine.plan",
      "_applyEngine.upload",
      "_applyEngine.commit",
      "_applyEngine.status",
      // CI token exchange is intentionally credential-helper-only in v1.
      "ci.exchangeToken",
      // ─── SSR origin cache (v1.52) — flag-variants of `run402 cache invalidate` ─
      // Single-URL form is the canonical CLI; prefix/all/many are SDK-side
      // convenience methods that share the same CLI verb with flags.
      "cache.invalidatePrefix",
      "cache.invalidateAll",
      "cache.invalidateMany",
      // ─── Named-wallet server label sync (best-effort; private gateway companion) ─
      // Used internally by `run402 wallets new|rename|import` (gated) and by
      // direct SDK consumers; no dedicated MCP/CLI verb.
      "wallets.getLabel",
      "wallets.setLabel",
      // ─── call-shape conventions (sdk-positional-arg-ergonomics) ───────────
      // r.admin.org(id) / r.admin.project(id) are operator scope-handle
      // factories (the admin analog of r.project(id)/r.org(id)). Their methods
      // (pinLease/unpinLease, archive/reactivate/finance) reach the existing
      // admin SURFACE capabilities (lease-perpetual, archive, reactivate,
      // finance). `_setLeasePerpetual` is the shared impl behind both the
      // deprecated boolean `setLeasePerpetual` and the pinLease/unpinLease handle.
      "admin.org",
      "admin.project",
      "admin._setLeasePerpetual",
      // ─── function-runtime-rebuild (v1.69) — project-wide variant ──────────
      // `functions.rebuild` (single) is the canonical capability; `rebuildAll`
      // shares the `run402 functions rebuild --all` CLI verb (and the
      // name-less `functions_rebuild` MCP tool), so it has no dedicated leaf command.
      "functions.rebuildAll",
      // Durable runs expose waiting as an option on create/redrive in CLI+MCP,
      // backed by the SDK polling helper rather than a separate surface noun.
      "functions.runs.wait",
      // Local idempotency-key helper used by agents/CLI; no gateway endpoint.
      "idempotency.fromParts",
      // Portable archive export uses `archives.export` as the happy path.
      // create/wait are low-level operation primitives used by the CLI/MCP
      // wrappers to surface progress and idempotent resume behavior.
      "archives.create",
      "archives.wait",
      // ─── operator session (human/email, RFC 8628) ────────────────────────
      // `operator login` brokers the device flow via deviceStart + devicePoll;
      // devicePoll shares the `login` verb (no dedicated capability), like the
      // cache.invalidate* variants above.
      "operator.devicePoll",
      // Loopback-PKCE write-login (v1.78): both helpers are part of the
      // `operator login --loopback` ceremony, with no dedicated capability.
      "operator.buildCliAuthorizeUrl",
      "operator.exchangeCliToken",
      // Operator-approval ceremony (v1.85/v1.87): requestChallenge is mapped to
      // `operator_approve`; exchangeClaimCode is the second half of the same
      // `operator approve` loopback dance, with no dedicated capability.
      "operator.approval.exchangeClaimCode",
      // ─── hosted control-plane session (v1.78, passkey-principals-onboarding) ─
      // `r.operator.session.*` is the browser/console session-login client
      // surface (email magic-link / passkey / OAuth / lifecycle / step-up /
      // recovery / authenticators). Browser-interactive by design — no MCP tool
      // and no dedicated CLI verb (the CLI write-login is the loopback ceremony
      // above; `whoami` is also called internally to surface claimed invites).
      "operator.session.email",
      "operator.session.verifyEmail",
      "operator.session.passkeyOptions",
      "operator.session.passkeyVerify",
      "operator.session.oauthUrl",
      "operator.session.consumeRecoveryCode",
      "operator.session.whoami",
      "operator.session.refresh",
      "operator.session.revoke",
      "operator.session.enrollPasskeyOptions",
      "operator.session.enrollPasskeyVerify",
      "operator.session.stepUpOptions",
      "operator.session.stepUpVerify",
      "operator.session.issueRecoveryCodes",
      "operator.session.listAuthenticators",
      "operator.session.revokeAuthenticator",
      // SDK action runner exposes the generic dispatcher alongside the typed
      // `actions.up` convenience mapped to the CLI `up` capability.
      "actions.run",
      // App install state is the convergence ledger used by `run402 up`; it is
      // intentionally not a separate user-facing CLI/MCP command surface.
      "apps.upsertInstallState",
      "apps.getInstallState",
    ]);

    const sdkMethods = await listSdkMethods();
    const referenced = new Set(
      Object.values(SDK_BY_CAPABILITY).filter((v): v is string => v !== null),
    );
    const orphans = sdkMethods
      .filter((m) => !referenced.has(m))
      .filter((m) => !SDK_ONLY_METHODS.has(m));
    assert.deepEqual(
      orphans,
      [],
      `SDK exports methods that aren't referenced in SDK_BY_CAPABILITY. Either add them to SURFACE+SDK_BY_CAPABILITY, add to SDK_ONLY_METHODS for internal helpers, or remove from the SDK: ${orphans.join(", ")}`,
    );
  });
});

describe("CLI/MCP SDK-boundary guard", () => {
  it("keeps production interface code from bypassing the SDK for gateway calls", () => {
    const allowlist = new Map<string, RegExp[]>([
      // The v2.1.0 unified-apply pipeline removed every presigned-PUT
      // call in cli/lib/assets.mjs and src/tools/assets-put.ts — both now
      // delegate to `sdk.assets.put` (which routes through the apply
      // hero). Those allowlist entries are kept out so a regression that
      // reintroduces raw HTTP from a tool file fails the guard.
      ["cli/lib/allowance.mjs", [/\bfetch\(TEMPO_RPC\b/]], // Tempo faucet/RPC
      ["cli/lib/init.mjs", [/\bfetch\(TEMPO_RPC\b/]], // Tempo faucet/RPC
      ["cli/lib/ci.mjs", [/\bfetch\(`https:\/\/api\.github\.com\/repos\//]], // GitHub repository lookup
      ["src/tools/init.ts", [/\bfetch\(TEMPO_RPC\b/]], // Tempo faucet/RPC
      // doctor-source-scan.mjs documents the canonical fix string for
      // browser-bearer scans — the string itself contains "auth.fetch()"
      // as the recommended replacement, not a real fetch call.
      ["cli/lib/doctor-source-scan.mjs", [/Use auth\.fetch\(\) for same-origin/]],
      // init-astro.mjs emits scaffold *strings* that get written into the
      // user's generated project. `auth.fetch("/api/internal")` is the
      // recommended SDK pattern shown in the template — it is template
      // text, not a CLI-runtime fetch.
      ["cli/lib/init-astro.mjs", [/auth\.fetch\("\/api\/internal"\)/, /Cross-origin-safe fetch/]],
    ]);

    const violations: string[] = [];
    for (const file of productionInterfaceFiles()) {
      const rel = file.slice(__dirname.length + 1);
      const allowed = allowlist.get(rel) ?? [];
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (/\bapiRequest\s*\(/.test(line)) {
          violations.push(`${rel}:${index + 1}: apiRequest()`);
        }
        if (/\bfetch\s*\(/.test(line) && !allowed.some((pattern) => pattern.test(line))) {
          violations.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    assert.deepEqual(
      violations,
      [],
      "Production CLI/MCP handlers must call Run402 through @run402/sdk. " +
        "Only presigned storage PUTs and non-Run402 external RPC/API calls may be allowlisted.",
    );
  });
});

function productionInterfaceFiles(): string[] {
  const cliLib = join(__dirname, "cli/lib");
  const srcTools = join(__dirname, "src/tools");
  return [
    ...readdirSync(cliLib)
      .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
      .map((name) => join(cliLib, name)),
    ...readdirSync(srcTools)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => join(srcTools, name)),
  ].sort();
}

describe("first-party callers use only canonical SDK call shapes", () => {
  // The deprecated positional overloads (sdk-call-shape-conventions) exist for
  // external back-compat only. First-party code (CLI `cli/lib/*` + MCP
  // `src/tools/*`) MUST use the canonical handle/options forms. This guards the
  // FULLY-deprecated methods — ones with no same-name canonical overload, so a
  // bare token match is unambiguous. The overloaded reshapes (domains.add /
  // secrets.set / subdomains.claim / members.setRole / transfers.cancel /
  // projects.rest) are covered by the SDK deprecation unit tests; their
  // positional arm can't be regex-detected without false positives.
  const BANNED = [
    { token: "setLeasePerpetual(", fix: "use r.admin.org(orgId).pinLease()/unpinLease()" },
    { token: "wallets.setLabel(", fix: "use r.wallet(address).setLabel(label)" },
  ];
  for (const file of productionInterfaceFiles()) {
    const rel = file.replace(__dirname + "/", "");
    it(`${rel} avoids fully-deprecated SDK methods`, () => {
      const text = readFileSync(file, "utf-8");
      for (const { token, fix } of BANNED) {
        assert.ok(
          !text.includes(token),
          `${rel} uses deprecated \`${token}\` — ${fix}`,
        );
      }
    });
  }
});

describe("SURFACE consistency", () => {
  it("has no duplicate capability IDs", () => {
    const ids = SURFACE.map(c => c.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(dupes, [], `Duplicate capability IDs: ${dupes.join(", ")}`);
  });

  it("has no duplicate MCP tool names", () => {
    const tools = SURFACE.map(c => c.mcp).filter(Boolean);
    const dupes = tools.filter((t, i) => tools.indexOf(t) !== i);
    assert.deepEqual(dupes, [], `Duplicate MCP tool names: ${dupes.join(", ")}`);
  });

  it("has no duplicate CLI commands", () => {
    const cmds = SURFACE.map(c => c.cli).filter(Boolean);
    const dupes = cmds.filter((c, i) => cmds.indexOf(c) !== i);
    assert.deepEqual(dupes, [], `Duplicate CLI commands: ${dupes.join(", ")}`);
  });

  it("every capability is covered by at least one interface", () => {
    const uncovered = SURFACE.filter(c => !c.mcp && !c.cli && !c.openclaw);
    assert.deepEqual(
      uncovered.map(c => c.id),
      [],
      `Capabilities with no implementation in any interface: ${uncovered.map(c => c.id).join(", ")}`,
    );
  });
});

describe("deploy route surface alignment", () => {
  it("keeps route authoring documented across public agent surfaces", () => {
    const requiredFiles = [
      "README.md",
      "llms.txt",
      "SKILL.md",
      "openclaw/SKILL.md",
      "cli/README.md",
      "cli/llms-cli.txt",
      "llms-mcp.txt",
      "sdk/README.md",
      "sdk/llms-sdk.txt",
    ];
    const requiredPatterns = [
      [/routes\.replace|routes"\s*:\s*\{\s*"replace"/, "routes.replace"],
      [/\/admin\b/, "/admin exact route"],
      [/\/admin\/\*/, "/admin/* prefix route"],
      [/Fetch Request -> Response/, "Fetch Request -> Response handler"],
      [/req\.url/, "public req.url preservation"],
      [/verified custom domains|custom domains/, "custom-domain parity"],
      [/\/functions\/v1\/:name/, "protected direct function invoke"],
      [/ROUTE_MANIFEST_LOAD_FAILED/, "route manifest failure code"],
      [/ROUTED_INVOKE_WORKER_SECRET_MISSING/, "custom-domain worker secret failure code"],
      [/ROUTED_RESPONSE_TOO_LARGE/, "response-size failure code"],
    ];
    for (const file of requiredFiles) {
      const text = readFileSync(join(__dirname, file), "utf-8");
      for (const [pattern, label] of requiredPatterns) {
        assert.match(text, pattern, `${file} must document ${label}`);
      }
      assert.doesNotMatch(
        text,
        /routedHttp\.json\(\{ ok: true, path: event\.path \}\)/,
        `${file} must not use the old raw-envelope routedHttp example as the public handler contract`,
      );
    }
  });

  it("keeps scoped CI route delegation documented across public agent surfaces", () => {
    const requiredDocs: Array<{ file: string; patterns: RegExp[] }> = [
      { file: "README.md", patterns: [/--route-scope/, /CI_ROUTE_SCOPE_DENIED/] },
      { file: "cli/README.md", patterns: [/--route-scope/] },
      { file: "cli/llms-cli.txt", patterns: [/--route-scope/, /CI_ROUTE_SCOPE_DENIED/] },
      { file: "sdk/README.md", patterns: [/route_scopes/, /CI_ROUTE_SCOPE_DENIED/] },
      { file: "sdk/llms-sdk.txt", patterns: [/route_scopes/, /CI_ROUTE_SCOPE_DENIED/] },
      { file: "llms-mcp.txt", patterns: [/ci_create_binding/, /route_scopes/, /CI_ROUTE_SCOPE_DENIED/] },
      { file: "SKILL.md", patterns: [/ci_create_binding/, /route_scopes/, /CI_ROUTE_SCOPE_DENIED/] },
      { file: "openclaw/SKILL.md", patterns: [/--route-scope/, /CI_ROUTE_SCOPE_DENIED/] },
      { file: "AGENTS.md", patterns: [/route_scopes/, /CI_ROUTE_SCOPE_DENIED/] },
    ];

    for (const { file, patterns } of requiredDocs) {
      const text = readFileSync(join(__dirname, file), "utf-8");
      for (const pattern of patterns) {
        assert.match(text, pattern, `${file} must document scoped CI route delegation with ${pattern}`);
      }
    }
  });

  it("keeps stable static asset identity, public paths, and URL diagnostics documented", () => {
    const docs: Array<{ file: string; patterns: Array<[RegExp, string]> }> = [
      {
        file: "README.md",
        patterns: [
          [/site\.public_paths/, "site public path authoring"],
          [/\/events\.html.*not public|not public.*\/events\.html/, "explicit mode hides backing asset filename"],
          [/static_public_paths/, "static public path inventory"],
          [/reachability_authority/, "reachability authority field"],
          [/deploy_diagnose_url/, "MCP diagnose tool"],
          [/run402 deploy diagnose/, "CLI diagnose command"],
          [/run402 deploy resolve/, "CLI resolve command"],
          [/"target": \{ "type": "static", "file": "events\.html" \}/, "static route target JSON"],
          [/static_assets/, "static asset diff counters"],
          [/release_generation/, "release generation"],
          [/static_manifest_sha256/, "static manifest digest"],
          [/static_manifest_metadata/, "static manifest metadata"],
          [/host_missing/, "host-miss resolve literal"],
          [/spa_fallback_missing/, "SPA fallback-missing resolve literal"],
          [/STATIC_ALIAS_RELATIVE_ASSET_RISK/, "static route target warning"],
        ],
      },
      {
        file: "SKILL.md",
        patterns: [
          [/site\.public_paths/, "site public path authoring"],
          [/\/events\.html.*not public|not public.*\/events\.html/, "explicit mode hides backing asset filename"],
          [/static_public_paths/, "static public path inventory"],
          [/reachability_authority/, "reachability authority field"],
          [/deploy_diagnose_url/, "MCP diagnose tool"],
          [/"target": \{ "type": "static", "file": "events\.html" \}/, "static route target JSON"],
          [/static_assets/, "static asset diff counters"],
          [/release_generation/, "release generation"],
          [/host_missing/, "host-miss resolve literal"],
          [/spa_fallback_missing/, "SPA fallback-missing resolve literal"],
          [/STATIC_ALIAS_RELATIVE_ASSET_RISK/, "static route target warning"],
        ],
      },
      {
        file: "llms-mcp.txt",
        patterns: [
          [/site\.public_paths/, "site public path authoring"],
          [/\/events\.html.*not public|not public.*\/events\.html/, "explicit mode hides backing asset filename"],
          [/static_public_paths/, "static public path inventory"],
          [/reachability_authority/, "reachability authority field"],
          [/deploy_diagnose_url/, "MCP diagnose tool"],
          [/"target": \{ "type": "static", "file": "events\.html" \}/, "static route target JSON"],
          [/request\.ignored/, "ignored query/fragment field"],
          [/static_assets/, "static asset diff counters"],
          [/static_manifest_metadata/, "static manifest metadata"],
          [/host_missing/, "host-miss resolve literal"],
          [/spa_fallback_missing/, "SPA fallback-missing resolve literal"],
          [/STATIC_ALIAS_RELATIVE_ASSET_RISK/, "static route target warning"],
        ],
      },
      {
        file: "cli/README.md",
        patterns: [
          [/site\.public_paths/, "site public path authoring"],
          [/\/events\.html.*not public|not public.*\/events\.html/, "explicit mode hides backing asset filename"],
          [/static_public_paths/, "static public path inventory"],
          [/reachability_authority/, "reachability authority field"],
          [/run402 deploy diagnose/, "CLI diagnose command"],
          [/run402 deploy resolve/, "CLI resolve command"],
          [/--url/, "resolve URL flag"],
          [/"target": \{ "type": "static", "file": "events\.html" \}/, "static route target JSON"],
          [/static_assets/, "static asset diff counters"],
          [/release_generation/, "release generation"],
          [/host_missing/, "host-miss resolve literal"],
          [/spa_fallback_missing/, "SPA fallback-missing resolve literal"],
          [/STATIC_ALIAS_RELATIVE_ASSET_RISK/, "static route target warning"],
        ],
      },
      {
        file: "cli/llms-cli.txt",
        patterns: [
          [/site\.public_paths/, "site public path authoring"],
          [/\/events\.html.*not public|not public.*\/events\.html/, "explicit mode hides backing asset filename"],
          [/static_public_paths/, "static public path inventory"],
          [/reachability_authority/, "reachability authority field"],
          [/run402 deploy diagnose/, "CLI diagnose command"],
          [/run402 deploy resolve/, "CLI resolve command"],
          [/--url/, "resolve URL flag"],
          [/"target": \{ "type": "static", "file": "events\.html" \}/, "static route target JSON"],
          [/static_assets/, "static asset diff counters"],
          [/static_manifest_metadata/, "static manifest metadata"],
          [/host_missing/, "host-miss resolve literal"],
          [/spa_fallback_missing/, "SPA fallback-missing resolve literal"],
          [/STATIC_ALIAS_RELATIVE_ASSET_RISK/, "static route target warning"],
        ],
      },
      {
        file: "sdk/README.md",
        patterns: [
          [/site\.public_paths/, "site public path authoring"],
          [/\/events\.html.*not public|not public.*\/events\.html/, "explicit mode hides backing asset filename"],
          [/static_public_paths/, "static public path inventory"],
          [/reachability_authority/, "reachability authority field"],
          [/r\.project\(id\)\.apply\.resolve/, "SDK resolve method"],
          [/DeployResolveResponse/, "SDK resolve response type"],
          [/target: \{ type: "static", file: "events\.html" \}/, "static route target TS"],
          [/static_assets/, "static asset diff counters"],
          [/release_generation/, "release generation"],
          [/static_manifest_metadata/, "static manifest metadata"],
          [/host_missing/, "host-miss resolve literal"],
          [/spa_fallback_missing/, "SPA fallback-missing resolve literal"],
          [/STATIC_ALIAS_RELATIVE_ASSET_RISK/, "static route target warning"],
        ],
      },
      {
        file: "sdk/llms-sdk.txt",
        patterns: [
          [/site\.public_paths/, "site public path authoring"],
          [/\/events\.html.*not public|not public.*\/events\.html/, "explicit mode hides backing asset filename"],
          [/static_public_paths/, "static public path inventory"],
          [/reachability_authority/, "reachability authority field"],
          [/r\.project\(id\)\.apply\.resolve/, "SDK resolve method"],
          [/DeployResolveOptions/, "SDK resolve options type"],
          [/DeployResolveResponse/, "SDK resolve response type"],
          [/target: \{ type: "static", file: "events\.html" \}/, "static route target TS"],
          [/static_assets/, "static asset diff counters"],
          [/static_manifest_sha256/, "static manifest digest"],
          [/host_missing/, "host-miss resolve literal"],
          [/spa_fallback_missing/, "SPA fallback-missing resolve literal"],
          [/STATIC_ALIAS_RELATIVE_ASSET_RISK/, "static route target warning"],
        ],
      },
      {
        file: "openclaw/SKILL.md",
        patterns: [
          [/site\.public_paths/, "site public path authoring"],
          [/\/events\.html.*not public|not public.*\/events\.html/, "explicit mode hides backing asset filename"],
          [/static_public_paths/, "static public path inventory"],
          [/reachability_authority/, "reachability authority field"],
          [/run402 deploy diagnose/, "CLI diagnose command"],
          [/run402 deploy resolve/, "CLI resolve command"],
          [/"target": \{ "type": "static", "file": "events\.html" \}/, "static route target JSON"],
          [/static_assets/, "static asset diff counters"],
          [/release_generation/, "release generation"],
          [/host_missing/, "host-miss resolve literal"],
          [/spa_fallback_missing/, "SPA fallback-missing resolve literal"],
          [/STATIC_ALIAS_RELATIVE_ASSET_RISK/, "static route target warning"],
        ],
      },
      {
        file: "openclaw/README.md",
        patterns: [
          [/site\.public_paths/, "site public path authoring"],
          [/static_public_paths/, "static public path inventory"],
          [/reachability_authority/, "reachability authority field"],
          [/run402 deploy diagnose/, "CLI diagnose command"],
          [/"type": "static", "file": "events\.html"/, "static route target JSON"],
          [/static_assets/, "static asset diff counters"],
          [/static_manifest_sha256/, "static manifest digest"],
        ],
      },
      {
        file: "documentation.md",
        patterns: [
          [/site\.public_paths/, "site public path authoring"],
          [/static_public_paths/, "static public path inventory"],
          [/reachability_authority/, "reachability authority field"],
          [/stable static asset identity \/ public URL diagnostics/, "documentation checklist row"],
          [/deploy_diagnose_url/, "MCP diagnose tool"],
          [/run402 deploy diagnose/, "CLI diagnose command"],
          [/static route target/, "static route target wording"],
        ],
      },
    ];

    for (const { file, patterns } of docs) {
      const text = readFileSync(join(__dirname, file), "utf-8");
      for (const [pattern, label] of patterns) {
        assert.match(text, pattern, `${file} must document ${label}`);
      }
    }
  });

  it("keeps stable-host resolve diagnostic fields documented across public surfaces", () => {
    const docs = [
      "README.md",
      "SKILL.md",
      "llms-mcp.txt",
      "cli/README.md",
      "cli/llms-cli.txt",
      "sdk/README.md",
      "sdk/llms-sdk.txt",
      "openclaw/SKILL.md",
      "openclaw/README.md",
      "documentation.md",
      "AGENTS.md",
    ];
    const required: Array<[RegExp, string]> = [
      [/authorization_result/, "authorization result field"],
      [/cas_object/, "CAS object diagnostics"],
      [/response_variant/, "response variant diagnostics"],
      [/active_release_missing/, "active release missing resolve literal"],
      [/unsupported_manifest_version/, "unsupported manifest version resolve literal"],
      [/negative_cache_hit/, "negative cache hit fallback literal"],
      [/route_function/, "function route resolve literal"],
      [/route_static_alias/, "static route alias resolve literal"],
      [/route_method_miss/, "route method miss resolve literal"],
    ];

    for (const file of docs) {
      const text = readFileSync(join(__dirname, file), "utf-8");
      for (const [pattern, label] of required) {
        assert.match(text, pattern, `${file} must document ${label}`);
      }
    }
  });

  it("keeps SDK route types and MCP route renderers in sync", () => {
    const deployTypes = readFileSync(join(__dirname, "sdk/src/namespaces/deploy.types.ts"), "utf-8");
    for (const name of [
      "RouteHttpMethod",
      "ROUTE_HTTP_METHODS",
      "FunctionRouteTarget",
      "StaticRouteTarget",
      "RouteTarget",
      "RouteSpec",
      "ReleaseRoutesSpec",
      "RouteEntry",
      "MaterializedRoutes",
      "RoutesDiff",
      "RouteChangeEntry",
      "StaticManifestMetadata",
      "StaticAssetsDiff",
      "DeployResolveOptions",
      "DeployResolveAuthorizationResult",
      "KnownDeployResolveAuthorizationResult",
      "DeployResolveCasObject",
      "DeployResolveResponse",
      "DeployResolveResponseVariant",
      "DeployResolveSummary",
    ]) {
      assert.match(deployTypes, new RegExp(`export (?:interface|type|const) ${name}\\b`), `missing SDK route export ${name}`);
    }

    const mcpDeploy = readFileSync(join(__dirname, "src/tools/deploy.ts"), "utf-8");
    assert.match(mcpDeploy, /ROUTE_HTTP_METHODS/, "MCP deploy schema must share route method constants");
    assert.match(mcpDeploy, /Raw Deploy Result/, "MCP deploy success must include raw deploy result JSON");

    const releaseTool = readFileSync(join(__dirname, "src/tools/deploy-release.ts"), "utf-8");
    assert.match(releaseTool, /\| routes \|/, "MCP release inventory summary must include route count");
    assert.match(releaseTool, /routes_added_removed_changed/, "MCP release diff summary must include route buckets");
    assert.match(releaseTool, /static_manifest_sha256/, "MCP release inventory summary must include static manifest digest");
    assert.match(releaseTool, /static_assets_unchanged_changed_added_removed/, "MCP release diff summary must include static asset buckets");
  });
});

// ─── ReleaseSpec schema hosting contract ────────────────────────────────────

const PRIVATE_SITE_SCHEMA_DIR = join(homedir(), "Developer/run402-private/site/schemas");
const PRIVATE_SITE_RELEASE_SPEC_SCHEMA_PATH = join(PRIVATE_SITE_SCHEMA_DIR, "release-spec.v1.json");
const privateSiteSchemasAvailable = existsSync(PRIVATE_SITE_SCHEMA_DIR);

describe("ReleaseSpec schema hosting contract", () => {
  const schemaText = readFileSync(RELEASE_SPEC_SCHEMA_PATH, "utf-8");
  const schema = JSON.parse(schemaText) as {
    $id?: string;
    properties?: Record<string, unknown>;
    $defs?: Record<string, unknown>;
  };

  it("checked-in schema is anchored at the hosted URL", () => {
    assert.equal(schema.$id, RELEASE_SPEC_SCHEMA_URL);
    assert.ok(schema.properties?.$schema, "schema must allow top-level $schema metadata");
    assert.ok(schema.$defs?.functionSpec, "schema must define FunctionSpec");
  });

  it("agent docs point at the hosted schema URL", () => {
    const docs = [
      readFileSync(join(__dirname, "sdk/llms-sdk.txt"), "utf-8"),
      readFileSync(join(__dirname, "cli/llms-cli.txt"), "utf-8"),
    ].join("\n");
    assert.ok(docs.includes(RELEASE_SPEC_SCHEMA_URL), "llms SDK/CLI docs must mention the ReleaseSpec schema URL");
  });

  it(
    "private-site hosted copy matches the checked-in schema",
    { skip: !privateSiteSchemasAvailable && "~/Developer/run402-private/site/schemas not found" },
    () => {
      assert.ok(
        existsSync(PRIVATE_SITE_RELEASE_SPEC_SCHEMA_PATH),
        `missing hosted schema copy at ${PRIVATE_SITE_RELEASE_SPEC_SCHEMA_PATH}`,
      );
      assert.deepEqual(
        JSON.parse(readFileSync(PRIVATE_SITE_RELEASE_SPEC_SCHEMA_PATH, "utf-8")),
        schema,
        "copy schemas/release-spec.v1.json to run402-private/site/schemas/release-spec.v1.json",
      );
    },
  );
});

// ─── Agent deploy-friction docs drift guards ────────────────────────────────

describe("agent deploy-friction docs stay visible", () => {
  const publicDocs: Array<{ file: string; patterns: Array<[RegExp, string]> }> = [
    {
      file: "cli/llms-cli.txt",
      patterns: [
        [/release-spec\.v1\.json/, "ReleaseSpec schema URL"],
        [/--stdin/, "secret stdin guidance"],
        [/--allow-warning <code>/, "warning-code acknowledgement flag"],
        [/--final-only/, "final-only deploy output"],
        [/Function authoring limits by tier/, "tier function caps"],
        [/BAD_FIELD/, "structured tier preflight errors"],
        [/ai\.generateImage/, "runtime image helper"],
      ],
    },
    {
      file: "sdk/llms-sdk.txt",
      patterns: [
        [/FunctionSpec/, "FunctionSpec docs"],
        [/required-id `triggers\[\]`/s, "schedule trigger placement"],
        [/Each scheduled tick creates a durable function run/s, "schedule trigger durable run behavior"],
        [/allowWarningCodes/, "SDK warning-code acknowledgement"],
        [/acknowledge_readonly/, "route-level readonly acknowledgement"],
        [/function_limits/, "tier status function caps"],
        [/BAD_FIELD/, "structured tier preflight errors"],
        [/ai\.generateImage/, "runtime image helper"],
      ],
    },
    {
      file: "llms-mcp.txt",
      patterns: [
        [/allow_warning_codes/, "MCP warning-code acknowledgement"],
        [/acknowledge_readonly/, "MCP readonly route acknowledgement"],
        [/function authoring caps|Function timeout/s, "tier caps"],
        [/ai\.generateImage/, "runtime image helper"],
      ],
    },
    {
      file: "SKILL.md",
      patterns: [
        [/allow_warning_codes/, "MCP skill warning-code acknowledgement"],
        [/acknowledge_readonly/, "MCP skill readonly route acknowledgement"],
        [/Function authoring limits/, "tier caps"],
        [/ai\.generateImage/, "runtime image helper"],
      ],
    },
    {
      file: "openclaw/SKILL.md",
      patterns: [
        [/--allow-warning/, "OpenClaw warning-code acknowledgement"],
        [/--final-only/, "OpenClaw final-only output"],
        [/acknowledge_readonly/, "OpenClaw readonly route acknowledgement"],
        [/BAD_FIELD/, "tier preflight structured error"],
        [/ai\.generateImage/, "runtime image helper"],
      ],
    },
    {
      file: "sdk/README.md",
      patterns: [
        [/allowWarningCodes/, "SDK README warning-code acknowledgement"],
        [/BAD_FIELD/, "SDK README tier preflight error"],
        [/activation_pending/, "SDK README activation failure classifier"],
      ],
    },
  ];

  for (const { file, patterns } of publicDocs) {
    it(`${file} documents agent deploy-friction surfaces`, () => {
      const text = readFileSync(join(__dirname, file), "utf-8");
      for (const [pattern, label] of patterns) {
        assert.match(text, pattern, `${file} must document ${label}`);
      }
    });
  }

  it("ReleaseSpec schema and SDK types expose acknowledgement/tier surfaces", () => {
    const schemaText = readFileSync(RELEASE_SPEC_SCHEMA_PATH, "utf-8");
    assert.match(schemaText, /acknowledge_readonly/, "schema must document readonly route acknowledgement");
    assert.match(schemaText, /schedule/, "schema must document function schedules");

    const deployTypes = readFileSync(join(__dirname, "sdk/src/namespaces/deploy.types.ts"), "utf-8");
    assert.match(deployTypes, /allowWarningCodes/, "ApplyOptions must expose allowWarningCodes");
    assert.match(deployTypes, /acknowledge_readonly/, "RouteSpec must expose acknowledge_readonly");

    const tierTypes = readFileSync(join(__dirname, "sdk/src/namespaces/tier.ts"), "utf-8");
    for (const field of [
      "max_function_timeout_seconds",
      "max_function_memory_mb",
      "max_scheduled_functions",
      "min_cron_interval_minutes",
      "current_scheduled_functions",
    ]) {
      assert.match(tierTypes, new RegExp(field), `tier status type must expose ${field}`);
    }
  });
});

// ─── Coverage summary (informational — always runs, prints gaps) ─────────────

describe("coverage summary", () => {
  it("prints current coverage matrix", () => {
    const mcpOnly = SURFACE.filter(c => c.mcp && !c.cli);
    const cliOnly = SURFACE.filter(c => !c.mcp && c.cli);
    const both = SURFACE.filter(c => c.mcp && c.cli);

    const lines = [
      `\n  Coverage: ${both.length} in both MCP+CLI, ${mcpOnly.length} MCP-only, ${cliOnly.length} CLI-only`,
      ``,
      `  MCP-only (no CLI/OpenClaw equivalent):`,
      ...mcpOnly.map(c => `    - ${c.mcp} (${c.endpoint})`),
      ``,
      `  CLI-only (no MCP equivalent):`,
      ...cliOnly.map(c => `    - ${c.cli} (${c.endpoint})`),
    ];

    // This test always passes — it's purely informational
    console.log(lines.join("\n"));
    assert.ok(true);
  });
});

describe("agent-skills discovery index", () => {
  // The public repo is authoritative for the skill digest. The committed
  // .well-known/agent-skills/index.json must match the current SKILL.md bytes
  // (regenerate with `node scripts/build-agent-skills-index.mjs`) and advertise
  // the canonical docs.run402.com SKILL.md URL (Option C — agent-docs-self-host).
  it("index.json digest matches SKILL.md and points at the docs host", () => {
    const skill = readFileSync(join(__dirname, "SKILL.md"), "utf-8");
    const expected = "sha256:" + createHash("sha256").update(skill, "utf8").digest("hex");
    const index = JSON.parse(
      readFileSync(join(__dirname, ".well-known/agent-skills/index.json"), "utf-8"),
    );
    const entry = index.skills?.[0];
    assert.ok(entry, "discovery index must list the run402 skill");
    assert.equal(
      entry.digest,
      expected,
      "index digest must equal sha256(SKILL.md) — run `node scripts/build-agent-skills-index.mjs`",
    );
    assert.equal(
      entry.url,
      "https://docs.run402.com/SKILL.md",
      "index url must be the canonical docs.run402.com SKILL.md",
    );
  });
});

describe("agent-docs URL split (agent-docs-self-host cutover guard)", () => {
  // The deep references (llms-cli/sdk/mcp.txt + SKILL.md) are served at
  // docs.run402.com; the llms.txt wayfinder + the agent-skills discovery index
  // stay on the apex run402.com. Guard against any doc routing agents to the
  // apex for a moved deep reference.
  const MOVED_AT_APEX = /\/\/run402\.com\/(?:llms-cli|llms-sdk|llms-mcp)\.txt|\/\/run402\.com\/SKILL\.md/;
  const AGENT_DOCS = [
    "llms.txt", "llms-mcp.txt", "SKILL.md",
    "cli/llms-cli.txt", "sdk/llms-sdk.txt",
    "README.md", "cli/README.md", "sdk/README.md",
    "openclaw/README.md", "openclaw/SKILL.md",
  ];

  it("no agent doc links a moved deep-reference at the apex (must be docs.run402.com)", () => {
    for (const f of AGENT_DOCS) {
      const text = readFileSync(join(__dirname, f), "utf-8");
      assert.doesNotMatch(
        text,
        MOVED_AT_APEX,
        `${f} links a moved deep-reference at run402.com — use docs.run402.com`,
      );
    }
  });

  it("the llms.txt wayfinder points to the CLI/SDK/MCP deep references on docs.run402.com", () => {
    const wayfinder = readFileSync(join(__dirname, "llms.txt"), "utf-8");
    for (const doc of ["llms-cli", "llms-sdk", "llms-mcp"]) {
      assert.match(
        wayfinder,
        new RegExp(`//docs\\.run402\\.com/${doc}\\.txt`),
        `wayfinder must link ${doc}.txt on docs.run402.com`,
      );
    }
  });
});
