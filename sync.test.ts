/**
 * sync.test.ts — Ensures MCP, CLI, and OpenClaw interfaces stay in sync
 * with the Run402 API surface defined in llms.txt.
 *
 * Run:  node --test --import tsx sync.test.ts
 *       npm run test:sync
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  for (const mod of ["allowance", "tier", "projects", "image", "storage", "blob", "cdn", "functions", "secrets", "sites", "subdomains", "domains", "apps", "email", "message", "agent", "ai", "auth", "sender-domain", "billing", "contracts", "webhooks", "service", "deploy", "ci"]) {
    for (const sub of parseSubcommands(join(__dirname, "cli/lib", `${mod}.mjs`))) {
      cmds.push(`${mod}:${sub}`);
    }
  }
  for (const action of parseDeployReleaseActions()) {
    cmds.push(`deploy:release:${action}`);
  }
  if (existsSync(join(__dirname, "cli/lib/deploy.mjs"))) cmds.push("deploy");
  if (existsSync(join(__dirname, "cli/lib/init.mjs"))) cmds.push("init");
  if (existsSync(join(__dirname, "cli/lib/status.mjs"))) cmds.push("status");
  return cmds.sort();
}

/** Parse OpenClaw commands as "module:subcommand" pairs */
function parseOpenClawCommands(): string[] {
  const cmds: string[] = [];
  for (const mod of ["allowance", "tier", "projects", "image", "storage", "blob", "cdn", "functions", "secrets", "sites", "subdomains", "domains", "apps", "email", "message", "agent", "ai", "auth", "sender-domain", "billing", "contracts", "webhooks", "service", "deploy", "ci"]) {
    for (const sub of parseSubcommands(join(__dirname, "openclaw/scripts", `${mod}.mjs`))) {
      cmds.push(`${mod}:${sub}`);
    }
  }
  for (const action of parseDeployReleaseActions()) {
    cmds.push(`deploy:release:${action}`);
  }
  if (existsSync(join(__dirname, "openclaw/scripts/deploy.mjs"))) cmds.push("deploy");
  if (existsSync(join(__dirname, "openclaw/scripts/init.mjs"))) cmds.push("init");
  if (existsSync(join(__dirname, "openclaw/scripts/status.mjs"))) cmds.push("status");
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

/** Parse MCP tool names from the llms.txt MCP Tools table */
function parseLlmsTxtMcpTools(llmsTxt: string): string[] {
  const tools: string[] = [];
  const re = /\|\s*`([a-z_]+)`\s*\|/g;
  // Only match lines within the MCP Tools table (after "### MCP Tools" heading)
  const mcpSection = llmsTxt.split(/^### MCP Tools$/m)[1];
  if (!mcpSection) return tools;
  // Stop at the next ### heading or ---
  const tableSection = mcpSection.split(/^(?:###|---)/m)[0];
  let m;
  while ((m = re.exec(tableSection))) tools.push(m[1]);
  return tools.sort();
}

/** Extract API endpoints from llms.txt endpoint tables */
function parseLlmsTxtEndpoints(llmsTxt: string): string[] {
  const endpoints: string[] = [];
  // Match table rows like: | `/v1/projects` | POST | ... |
  // or: | `/v1/projects/:id/renew` | POST | ... |
  const re = /\|\s*`(\/[^`]+)`\s*\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|/g;
  let m;
  while ((m = re.exec(llmsTxt))) {
    endpoints.push(`${m[2]} ${m[1]}`);
  }
  return [...new Set(endpoints)].sort();
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
  { id: "init",              endpoint: "(local)",                              mcp: "init",                          cli: "init",                openclaw: "init" },
  { id: "status",            endpoint: "(local)",                              mcp: "status",                        cli: "status",              openclaw: "status" },

  // ── Project lifecycle ────────────────────────────────────────────────────
  { id: "get_quote",         endpoint: "POST /projects/v1/quote",                mcp: "get_quote",                    cli: "projects:quote",      openclaw: "projects:quote" },
  { id: "provision",         endpoint: "POST /projects/v1",                      mcp: "provision_postgres_project",    cli: "projects:provision",  openclaw: "projects:provision" },
  { id: "set_tier",           endpoint: "POST /tiers/v1/:tier",                   mcp: "set_tier",                      cli: "tier:set",            openclaw: "tier:set" },
  { id: "delete",            endpoint: "DELETE /projects/v1/:id",                mcp: "delete_project",                cli: "projects:delete",     openclaw: "projects:delete" },

  // ── Faucet ───────────────────────────────────────────────────────────────
  { id: "faucet",            endpoint: "POST /faucet/v1",                        mcp: "request_faucet",                cli: "allowance:fund",      openclaw: "allowance:fund" },

  // ── Database / Admin ─────────────────────────────────────────────────────
  { id: "run_sql",           endpoint: "POST /projects/v1/admin/:id/sql",        mcp: "run_sql",                       cli: "projects:sql",        openclaw: "projects:sql" },
  { id: "rest_query",        endpoint: "/rest/v1/:table",                        mcp: "rest_query",                    cli: "projects:rest",       openclaw: "projects:rest" },
  { id: "apply_expose",      endpoint: "POST /projects/v1/admin/:id/expose",     mcp: "apply_expose",                  cli: "projects:apply-expose", openclaw: "projects:apply-expose" },
  { id: "get_expose",        endpoint: "GET /projects/v1/admin/:id/expose",      mcp: "get_expose",                    cli: "projects:get-expose",   openclaw: "projects:get-expose" },
  { id: "get_schema",        endpoint: "GET /projects/v1/admin/:id/schema",      mcp: "get_schema",                    cli: "projects:schema",     openclaw: "projects:schema" },
  { id: "get_usage",         endpoint: "GET /projects/v1/admin/:id/usage",       mcp: "get_usage",                     cli: "projects:usage",      openclaw: "projects:usage" },

  // ── Blob (direct-to-S3 storage) ──────────────────────────────────────────
  { id: "blob_put",          endpoint: "POST /storage/v1/uploads",               mcp: "blob_put",       cli: "blob:put",         openclaw: "blob:put" },
  { id: "blob_get",          endpoint: "GET /storage/v1/blob/{key}",             mcp: "blob_get",       cli: "blob:get",         openclaw: "blob:get" },
  { id: "blob_ls",           endpoint: "GET /storage/v1/blobs",                  mcp: "blob_ls",        cli: "blob:ls",          openclaw: "blob:ls" },
  { id: "blob_rm",           endpoint: "DELETE /storage/v1/blob/{key}",          mcp: "blob_rm",        cli: "blob:rm",          openclaw: "blob:rm" },
  { id: "blob_sign",         endpoint: "POST /storage/v1/blob/{key}/sign",       mcp: "blob_sign",      cli: "blob:sign",        openclaw: "blob:sign" },
  // v1.45: agent-DX blob CDN diagnostics (CLI: blob diagnose / cdn wait-fresh).
  { id: "diagnose_public_url",   endpoint: "GET /storage/v1/blobs/diagnose",       mcp: "diagnose_public_url",     cli: "blob:diagnose",     openclaw: "blob:diagnose" },
  { id: "wait_for_cdn_freshness", endpoint: "GET /storage/v1/blobs/diagnose (poll)", mcp: "wait_for_cdn_freshness",  cli: "cdn:wait-fresh",    openclaw: "cdn:wait-fresh" },

  // ── Functions ────────────────────────────────────────────────────────────
  { id: "deploy_function",   endpoint: "POST /projects/v1/admin/:id/functions",              mcp: "deploy_function",   cli: "functions:deploy", openclaw: "functions:deploy" },
  { id: "invoke_function",   endpoint: "POST /functions/v1/:name",                            mcp: "invoke_function",   cli: "functions:invoke", openclaw: "functions:invoke" },
  { id: "get_function_logs", endpoint: "GET /projects/v1/admin/:id/functions/:name/logs",    mcp: "get_function_logs", cli: "functions:logs",   openclaw: "functions:logs" },
  { id: "list_functions",    endpoint: "GET /projects/v1/admin/:id/functions",                mcp: "list_functions",    cli: "functions:list",   openclaw: "functions:list" },
  { id: "delete_function",   endpoint: "DELETE /projects/v1/admin/:id/functions/:name",      mcp: "delete_function",   cli: "functions:delete", openclaw: "functions:delete" },
  { id: "update_function",   endpoint: "PATCH /projects/v1/admin/:id/functions/:name",     mcp: "update_function",   cli: "functions:update", openclaw: "functions:update" },

  // ── Secrets ──────────────────────────────────────────────────────────────
  { id: "set_secret",        endpoint: "POST /projects/v1/admin/:id/secrets/:key",   mcp: "set_secret",    cli: "secrets:set",    openclaw: "secrets:set" },
  { id: "list_secrets",      endpoint: "GET /projects/v1/admin/:id/secrets",         mcp: "list_secrets",  cli: "secrets:list",   openclaw: "secrets:list" },
  { id: "delete_secret",     endpoint: "DELETE /projects/v1/admin/:id/secrets/:key", mcp: "delete_secret", cli: "secrets:delete", openclaw: "secrets:delete" },

  // ── Sites / Subdomains ───────────────────────────────────────────────────
  { id: "deploy_site",       endpoint: "POST /deploy/v2/plans",             mcp: "deploy_site",       cli: "sites:deploy",       openclaw: "sites:deploy" },
  { id: "deploy_site_dir",   endpoint: "POST /deploy/v2/plans",             mcp: "deploy_site_dir",   cli: "sites:deploy-dir",   openclaw: "sites:deploy-dir" },
  { id: "claim_subdomain",   endpoint: "POST /subdomains/v1",              mcp: "claim_subdomain",   cli: "subdomains:claim",   openclaw: "subdomains:claim" },
  { id: "delete_subdomain",  endpoint: "DELETE /subdomains/v1/:name",      mcp: "delete_subdomain",  cli: "subdomains:delete",  openclaw: "subdomains:delete" },
  { id: "list_subdomains",   endpoint: "GET /subdomains/v1",               mcp: "list_subdomains",   cli: "subdomains:list",    openclaw: "subdomains:list" },

  // ── Custom domains ──────────────────────────────────────────────────────
  { id: "add_custom_domain",    endpoint: "POST /domains/v1",              mcp: "add_custom_domain",    cli: "domains:add",    openclaw: "domains:add" },
  { id: "list_custom_domains",  endpoint: "GET /domains/v1",               mcp: "list_custom_domains",  cli: "domains:list",   openclaw: "domains:list" },
  { id: "check_domain_status",  endpoint: "GET /domains/v1/:domain",       mcp: "check_domain_status",  cli: "domains:status", openclaw: "domains:status" },
  { id: "remove_custom_domain", endpoint: "DELETE /domains/v1/:domain",    mcp: "remove_custom_domain", cli: "domains:delete", openclaw: "domains:delete" },

  // ── Bundle deploy (legacy entry point — routes through v2 via SDK shim) ─
  { id: "bundle_deploy",     endpoint: "POST /deploy/v2/plans",            mcp: "bundle_deploy",     cli: "deploy",           openclaw: "deploy" },

  // ── Unified deploy (v1.34+) ──────────────────────────────────────────────
  { id: "deploy",            endpoint: "POST /deploy/v2/plans",                            mcp: "deploy",            cli: "deploy:apply",      openclaw: "deploy:apply" },
  { id: "deploy_resume",     endpoint: "POST /deploy/v2/operations/:id/resume",            mcp: "deploy_resume",     cli: "deploy:resume",     openclaw: "deploy:resume" },
  { id: "deploy_list",       endpoint: "GET /deploy/v2/operations",                        mcp: "deploy_list",       cli: "deploy:list",       openclaw: "deploy:list" },
  { id: "deploy_events",     endpoint: "GET /deploy/v2/operations/:id/events",             mcp: "deploy_events",     cli: "deploy:events",     openclaw: "deploy:events" },
  { id: "deploy_release_get",    endpoint: "GET /deploy/v2/releases/:id",                  mcp: "deploy_release_get",    cli: "deploy:release:get",    openclaw: "deploy:release:get" },
  { id: "deploy_release_active", endpoint: "GET /deploy/v2/releases/active",               mcp: "deploy_release_active", cli: "deploy:release:active", openclaw: "deploy:release:active" },
  { id: "deploy_release_diff",   endpoint: "GET /deploy/v2/releases/diff",                 mcp: "deploy_release_diff",   cli: "deploy:release:diff",   openclaw: "deploy:release:diff" },

  // ── CI/OIDC federation (CLI v1; MCP intentionally deferred) ─────────────
  { id: "ci_link_github",    endpoint: "POST /ci/v1/bindings",                              mcp: null,                cli: "ci:link",          openclaw: "ci:link" },
  { id: "ci_list_bindings",  endpoint: "GET /ci/v1/bindings",                               mcp: null,                cli: "ci:list",          openclaw: "ci:list" },
  { id: "ci_revoke_binding", endpoint: "POST /ci/v1/bindings/:id/revoke",                   mcp: null,                cli: "ci:revoke",        openclaw: "ci:revoke" },

  // ── Marketplace ──────────────────────────────────────────────────────────
  { id: "browse_apps",       endpoint: "GET /apps/v1",                              mcp: "browse_apps",   cli: "apps:browse",   openclaw: "apps:browse" },
  { id: "fork_app",          endpoint: "POST /fork/v1",                             mcp: "fork_app",      cli: "apps:fork",     openclaw: "apps:fork" },
  { id: "publish_app",       endpoint: "POST /projects/v1/admin/:id/publish",       mcp: "publish_app",   cli: "apps:publish",  openclaw: "apps:publish" },
  { id: "list_versions",     endpoint: "GET /projects/v1/admin/:id/versions",       mcp: "list_versions", cli: "apps:versions", openclaw: "apps:versions" },

  // ── Billing ──────────────────────────────────────────────────────────────
  { id: "check_balance",     endpoint: "GET /billing/v1/accounts/:wallet",           mcp: "check_balance",  cli: "allowance:balance", openclaw: "allowance:balance" },
  { id: "list_projects",     endpoint: "GET /wallets/v1/:wallet/projects",           mcp: "list_projects",  cli: "projects:list",  openclaw: "projects:list" },
  { id: "project_info",      endpoint: "(local)",                                    mcp: "project_info",   cli: "projects:info",  openclaw: "projects:info" },
  { id: "project_use",       endpoint: "(local)",                                    mcp: "project_use",    cli: "projects:use",   openclaw: "projects:use" },
  { id: "project_keys",      endpoint: "(local)",                                    mcp: "project_keys",   cli: "projects:keys",  openclaw: "projects:keys" },

  // ── Image generation ─────────────────────────────────────────────────────
  { id: "generate_image",    endpoint: "POST /generate-image/v1",           mcp: "generate_image",   cli: "image:generate",   openclaw: "image:generate" },

  // ── Email ──────────────────────────────────────────────────────────────
  { id: "create_mailbox",  endpoint: "POST /mailboxes/v1",                      mcp: "create_mailbox",  cli: "email:create",  openclaw: "email:create" },
  { id: "send_email",      endpoint: "POST /mailboxes/v1/:id/messages",         mcp: "send_email",      cli: "email:send",    openclaw: "email:send" },
  { id: "list_emails",     endpoint: "GET /mailboxes/v1/:id/messages",          mcp: "list_emails",     cli: "email:list",    openclaw: "email:list" },
  { id: "get_email",       endpoint: "GET /mailboxes/v1/:id/messages/:msgId",   mcp: "get_email",       cli: "email:get",     openclaw: "email:get" },
  { id: "get_email_raw",   endpoint: "GET /mailboxes/v1/:id/messages/:msgId/raw", mcp: "get_email_raw", cli: "email:get-raw", openclaw: "email:get-raw" },
  { id: "get_mailbox",     endpoint: "GET /mailboxes/v1",                        mcp: "get_mailbox",     cli: "email:info",    openclaw: "email:info" },
  { id: "delete_mailbox",  endpoint: "DELETE /mailboxes/v1/:id",                 mcp: "delete_mailbox",  cli: "email:delete",  openclaw: "email:delete" },
  { id: "reply_email",     endpoint: "POST /mailboxes/v1/:id/messages",          mcp: null,              cli: "email:reply",   openclaw: "email:reply" },

  // ── Mailbox webhooks ──────────────────────────────────────────────────
  { id: "register_mailbox_webhook", endpoint: "POST /mailboxes/v1/:id/webhooks",              mcp: "register_mailbox_webhook", cli: "webhooks:register", openclaw: "webhooks:register" },
  { id: "list_mailbox_webhooks",    endpoint: "GET /mailboxes/v1/:id/webhooks",               mcp: "list_mailbox_webhooks",    cli: "webhooks:list",     openclaw: "webhooks:list" },
  { id: "get_mailbox_webhook",      endpoint: "GET /mailboxes/v1/:id/webhooks/:webhook_id",   mcp: "get_mailbox_webhook",      cli: "webhooks:get",      openclaw: "webhooks:get" },
  { id: "delete_mailbox_webhook",   endpoint: "DELETE /mailboxes/v1/:id/webhooks/:webhook_id", mcp: "delete_mailbox_webhook",  cli: "webhooks:delete",   openclaw: "webhooks:delete" },
  { id: "update_mailbox_webhook",   endpoint: "PATCH /mailboxes/v1/:id/webhooks/:webhook_id", mcp: "update_mailbox_webhook",   cli: "webhooks:update",   openclaw: "webhooks:update" },

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

  // ── Additional billing ─────────────────────────────────────────────────
  { id: "create_checkout",   endpoint: "POST /billing/v1/checkouts",        mcp: "create_checkout",     cli: "allowance:checkout",  openclaw: "allowance:checkout" },
  { id: "billing_history",   endpoint: "GET /billing/v1/accounts/:wallet/history", mcp: "billing_history", cli: "allowance:history", openclaw: "allowance:history" },

  // ── Version management ─────────────────────────────────────────────────
  { id: "update_version",    endpoint: "PATCH /projects/v1/admin/:id/versions/:version_id", mcp: "update_version", cli: "apps:update", openclaw: "apps:update" },
  { id: "delete_version",    endpoint: "DELETE /projects/v1/admin/:id/versions/:version_id", mcp: "delete_version", cli: "apps:delete", openclaw: "apps:delete" },
  { id: "get_app",           endpoint: "GET /apps/v1/:version_id",          mcp: "get_app",             cli: "apps:inspect",     openclaw: "apps:inspect" },

  // ── Admin ──────────────────────────────────────────────────────────────
  { id: "pin_project",     endpoint: "POST /projects/v1/admin/:id/pin",    mcp: "pin_project",      cli: "projects:pin",     openclaw: "projects:pin" },
  { id: "promote_user",    endpoint: "POST /projects/v1/admin/:id/promote-user", mcp: "promote_user", cli: "projects:promote-user", openclaw: "projects:promote-user" },
  { id: "demote_user",     endpoint: "POST /projects/v1/admin/:id/demote-user",  mcp: "demote_user",  cli: "projects:demote-user",  openclaw: "projects:demote-user" },
  { id: "admin_project_finance", endpoint: "GET /admin/api/finance/project/:id", mcp: null, cli: "projects:costs", openclaw: "projects:costs" },

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

  // ── Custom sender domains ─────────────────────────────────────────────
  { id: "register_sender_domain", endpoint: "POST /email/v1/domains",    mcp: "register_sender_domain", cli: "sender-domain:register", openclaw: "sender-domain:register" },
  { id: "sender_domain_status",  endpoint: "GET /email/v1/domains",     mcp: "sender_domain_status",  cli: "sender-domain:status",   openclaw: "sender-domain:status" },
  { id: "remove_sender_domain",  endpoint: "DELETE /email/v1/domains",  mcp: "remove_sender_domain",  cli: "sender-domain:remove",   openclaw: "sender-domain:remove" },
  { id: "enable_sender_domain_inbound",  endpoint: "POST /email/v1/domains/inbound",   mcp: "enable_sender_domain_inbound",  cli: "sender-domain:inbound-enable",  openclaw: "sender-domain:inbound-enable" },
  { id: "disable_sender_domain_inbound", endpoint: "DELETE /email/v1/domains/inbound", mcp: "disable_sender_domain_inbound", cli: "sender-domain:inbound-disable", openclaw: "sender-domain:inbound-disable" },

  // ── Email billing accounts + Stripe tier checkout + email packs ───────
  { id: "create_email_billing_account", endpoint: "POST /billing/v1/accounts",                   mcp: "create_email_billing_account", cli: "billing:create-email",   openclaw: "billing:create-email" },
  { id: "link_wallet_to_account",       endpoint: "POST /billing/v1/accounts/:id/link-wallet",   mcp: "link_wallet_to_account",       cli: "billing:link-wallet",    openclaw: "billing:link-wallet" },
  { id: "tier_checkout",                endpoint: "POST /billing/v1/tiers/:tier/checkout",       mcp: "tier_checkout",                cli: "billing:tier-checkout",  openclaw: "billing:tier-checkout" },
  { id: "buy_email_pack",               endpoint: "POST /billing/v1/email-packs/checkout",       mcp: "buy_email_pack",               cli: "billing:buy-email-pack", openclaw: "billing:buy-email-pack" },
  { id: "set_auto_recharge",            endpoint: "POST /billing/v1/email-packs/auto-recharge",  mcp: "set_auto_recharge",            cli: "billing:auto-recharge",  openclaw: "billing:auto-recharge" },
  { id: "billing_balance",              endpoint: "GET /billing/v1/accounts/:id",                mcp: null,                           cli: "billing:balance",        openclaw: "billing:balance" },
  { id: "billing_history_cli",          endpoint: "GET /billing/v1/accounts/:id/history",        mcp: null,                           cli: "billing:history",        openclaw: "billing:history" },

  // ── Tier management ────────────────────────────────────────────────────
  { id: "tier_status",       endpoint: "GET /tiers/v1/status",             mcp: "tier_status",      cli: "tier:status",      openclaw: "tier:status" },

  // ── Allowance management ───────────────────────────────────────────────
  { id: "allowance_status",  endpoint: "(local)",                          mcp: "allowance_status", cli: "allowance:status", openclaw: "allowance:status" },
  { id: "allowance_create",  endpoint: "(local)",                          mcp: "allowance_create", cli: "allowance:create", openclaw: "allowance:create" },
  { id: "allowance_export",  endpoint: "(local)",                          mcp: "allowance_export", cli: "allowance:export", openclaw: "allowance:export" },

  // ── Service status (public, unauthenticated) ───────────────────────────
  { id: "service_status",    endpoint: "GET /status",                      mcp: "service_status",   cli: "service:status",   openclaw: "service:status" },
  { id: "service_health",    endpoint: "GET /health",                      mcp: "service_health",   cli: "service:health",   openclaw: "service:health" },

  // ── KMS contract wallets ───────────────────────────────────────────────
  { id: "provision_contract_wallet", endpoint: "POST /contracts/v1/wallets",                       mcp: "provision_contract_wallet", cli: "contracts:provision-wallet", openclaw: "contracts:provision-wallet" },
  { id: "get_contract_wallet",       endpoint: "GET /contracts/v1/wallets/:id",                    mcp: "get_contract_wallet",       cli: "contracts:get-wallet",       openclaw: "contracts:get-wallet" },
  { id: "list_contract_wallets",     endpoint: "GET /contracts/v1/wallets",                        mcp: "list_contract_wallets",     cli: "contracts:list-wallets",     openclaw: "contracts:list-wallets" },
  { id: "set_recovery_address",      endpoint: "POST /contracts/v1/wallets/:id/recovery-address",  mcp: "set_recovery_address",      cli: "contracts:set-recovery",     openclaw: "contracts:set-recovery" },
  { id: "set_low_balance_alert",     endpoint: "POST /contracts/v1/wallets/:id/alert",             mcp: "set_low_balance_alert",     cli: "contracts:set-alert",        openclaw: "contracts:set-alert" },
  { id: "contract_call",             endpoint: "POST /contracts/v1/call",                          mcp: "contract_call",             cli: "contracts:call",             openclaw: "contracts:call" },
  { id: "contract_read",             endpoint: "POST /contracts/v1/read",                          mcp: "contract_read",             cli: "contracts:read",             openclaw: "contracts:read" },
  { id: "get_contract_call_status",  endpoint: "GET /contracts/v1/calls/:id",                      mcp: "get_contract_call_status",  cli: "contracts:status",           openclaw: "contracts:status" },
  { id: "drain_contract_wallet",     endpoint: "POST /contracts/v1/wallets/:id/drain",             mcp: "drain_contract_wallet",     cli: "contracts:drain",            openclaw: "contracts:drain" },
  { id: "delete_contract_wallet",    endpoint: "DELETE /contracts/v1/wallets/:id",                 mcp: "delete_contract_wallet",    cli: "contracts:delete",           openclaw: "contracts:delete" },
];

// ─── SDK namespace mapping ──────────────────────────────────────────────────
// Each SURFACE capability that has an MCP/CLI implementation should map to
// an SDK method path `"namespace.method"`. Capabilities that are intentionally
// not on the SDK (legacy storage aliases, pure wire passthroughs like run_sql)
// map to null.
//
// When you add a new capability to SURFACE that ships an SDK method, also
// add the id → path mapping here. The tests below enforce both sides.

const SDK_BY_CAPABILITY: Record<string, string | null> = {
  // Local-only compound flows — MCP handlers compose SDK calls internally.
  init: null,
  status: null,

  // Project lifecycle
  get_quote: "projects.getQuote",
  provision: "projects.provision",
  set_tier: "tier.set",
  delete: "projects.delete",
  faucet: "allowance.faucet",

  // Database / Admin
  run_sql: "projects.sql",
  rest_query: "projects.rest",
  apply_expose: "projects.applyExpose",
  get_expose: "projects.getExpose",
  get_schema: "projects.getSchema",
  get_usage: "projects.getUsage",

  // Blob (direct-to-S3)
  blob_put: "blobs.put",
  blob_get: "blobs.get",
  blob_ls: "blobs.ls",
  blob_rm: "blobs.rm",
  blob_sign: "blobs.sign",
  // v1.45: agent-DX blob CDN diagnostics
  diagnose_public_url: "blobs.diagnoseUrl",
  wait_for_cdn_freshness: "blobs.waitFresh",

  // Functions
  deploy_function: "functions.deploy",
  invoke_function: "functions.invoke",
  get_function_logs: "functions.logs",
  list_functions: "functions.list",
  delete_function: "functions.delete",
  update_function: "functions.update",

  // Secrets
  set_secret: "secrets.set",
  list_secrets: "secrets.list",
  delete_secret: "secrets.delete",

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

  // Unified deploy (v1.34+)
  deploy: "deploy.apply",
  deploy_resume: "deploy.resume",
  deploy_list: "deploy.list",
  deploy_events: "deploy.events",
  deploy_release_get: "deploy.getRelease",
  deploy_release_active: "deploy.getActiveRelease",
  deploy_release_diff: "deploy.diff",
  ci_link_github: "ci.createBinding",
  ci_list_bindings: "ci.listBindings",
  ci_revoke_binding: "ci.revokeBinding",

  // Bundle / marketplace
  bundle_deploy: "apps.bundleDeploy",
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
  project_info: "projects.info",
  project_use: "projects.use",
  project_keys: "projects.keys",
  create_checkout: "billing.createCheckout",
  billing_history: "billing.history",
  create_email_billing_account: "billing.createEmailAccount",
  link_wallet_to_account: "billing.linkWallet",
  tier_checkout: "billing.tierCheckout",
  buy_email_pack: "billing.buyEmailPack",
  set_auto_recharge: "billing.setAutoRecharge",
  billing_balance: null, // CLI-only; identifier can be email or wallet — SDK models wallet
  billing_history_cli: null, // same reason

  // Image / AI
  generate_image: "ai.generateImage",
  ai_translate: "ai.translate",
  ai_moderate: "ai.moderate",
  ai_usage: "ai.usage",

  // Email
  create_mailbox: "email.createMailbox",
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

  // Messaging & agent contact
  send_message: "admin.sendMessage",
  set_agent_contact: "admin.setAgentContact",
  get_agent_contact_status: "admin.getAgentContactStatus",
  verify_agent_contact_email: "admin.verifyAgentContactEmail",
  start_operator_passkey_enrollment: "admin.startOperatorPasskeyEnrollment",

  // Admin
  pin_project: "projects.pin",
  promote_user: "auth.promote",
  demote_user: "auth.demote",
  admin_project_finance: "admin.getProjectFinance",

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
  provision_contract_wallet: "contracts.provisionWallet",
  get_contract_wallet: "contracts.getWallet",
  list_contract_wallets: "contracts.listWallets",
  set_recovery_address: "contracts.setRecovery",
  set_low_balance_alert: "contracts.setLowBalanceAlert",
  contract_call: "contracts.call",
  contract_read: "contracts.read",
  get_contract_call_status: "contracts.callStatus",
  drain_contract_wallet: "contracts.drain",
  delete_contract_wallet: "contracts.deleteWallet",
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
  const nodeAugments: Array<{ namespace: string; modulePath: string; exportName: string }> = [
    { namespace: "sites", modulePath: "./sdk/dist/node/sites-node.js", exportName: "NodeSites" },
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
const CLI_DISPATCH_COMMANDS = ["email:webhooks", "deploy:release"];

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
      "email.listMailboxes",   // private helper
      "email.resolveMailbox",  // private helper
      "projects.active",       // returns active project id from the provider
      // ─── unified-deploy ────────────────────────────────────────────────
      // The deploy namespace is the canonical primitive. apply() and resume()
      // are exposed via the `deploy` and `deploy_resume` MCP tools (and CLI
      // `run402 deploy` / `run402 deploy resume`). The other methods are
      // low-level debugging / composition surface used by the high-level
      // entry points and by tests; they don't have their own MCP/CLI
      // commands.
      "deploy.start",
      "deploy.plan",
      "deploy.upload",
      "deploy.commit",
      "deploy.status",
      // CI token exchange is intentionally credential-helper-only in v1.
      // `getBinding` is SDK/debug surface; public CLI exposes list/revoke.
      "ci.getBinding",
      "ci.exchangeToken",
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
      "SKILL.md",
      "openclaw/SKILL.md",
      "cli/llms-cli.txt",
      "llms-mcp.txt",
      "sdk/README.md",
      "sdk/llms-sdk.txt",
      "functions/README.md",
    ];
    for (const file of requiredFiles) {
      const text = readFileSync(join(__dirname, file), "utf-8");
      assert.match(text, /routes/gi, `${file} must mention deploy web routes`);
      assert.match(text, /replace/gi, `${file} must document routes.replace`);
      assert.match(text, /\/api\/\*/g, `${file} must include a /api/* route example`);
      assert.match(text, /\/functions\/v1\/:name/, `${file} must say direct function invoke remains protected`);
    }
  });

  it("keeps SDK route types and MCP route renderers in sync", () => {
    const deployTypes = readFileSync(join(__dirname, "sdk/src/namespaces/deploy.types.ts"), "utf-8");
    for (const name of [
      "RouteHttpMethod",
      "ROUTE_HTTP_METHODS",
      "FunctionRouteTarget",
      "RouteTarget",
      "RouteSpec",
      "ReleaseRoutesSpec",
      "RouteEntry",
      "MaterializedRoutes",
      "RoutesDiff",
      "RouteChangeEntry",
    ]) {
      assert.match(deployTypes, new RegExp(`export (?:interface|type|const) ${name}\\b`), `missing SDK route export ${name}`);
    }

    const mcpDeploy = readFileSync(join(__dirname, "src/tools/deploy.ts"), "utf-8");
    assert.match(mcpDeploy, /ROUTE_HTTP_METHODS/, "MCP deploy schema must share route method constants");
    assert.match(mcpDeploy, /Raw Deploy Result/, "MCP deploy success must include raw deploy result JSON");

    const releaseTool = readFileSync(join(__dirname, "src/tools/deploy-release.ts"), "utf-8");
    assert.match(releaseTool, /\| routes \|/, "MCP release inventory summary must include route count");
    assert.match(releaseTool, /routes_added_removed_changed/, "MCP release diff summary must include route buckets");
  });
});

// ─── llms.txt alignment (conditional — only if the main repo is available) ───

const LLMS_TXT_PATH = join(homedir(), "Developer/run402-private/site/llms.txt");
const llmsTxtAvailable = existsSync(LLMS_TXT_PATH);

describe("llms.txt alignment", { skip: !llmsTxtAvailable && "~/Developer/run402-private/site/llms.txt not found" }, () => {
  const llmsTxt = llmsTxtAvailable ? readFileSync(LLMS_TXT_PATH, "utf-8") : "";

  it("MCP Tools table lists all actual MCP tools", { skip: !llmsTxt.includes("### MCP Tools") && "llms.txt has no MCP Tools table" }, () => {
    const documented = parseLlmsTxtMcpTools(llmsTxt);
    const actual = parseMcpTools();
    const missing = actual.filter(t => !documented.includes(t));
    assert.deepEqual(
      missing,
      [],
      `llms.txt MCP Tools table is missing tools. Update the table in llms.txt: ${missing.join(", ")}`,
    );
  });

  it("MCP Tools table has no stale entries", { skip: !llmsTxt.includes("### MCP Tools") && "llms.txt has no MCP Tools table" }, () => {
    const documented = parseLlmsTxtMcpTools(llmsTxt);
    const actual = parseMcpTools();
    const stale = documented.filter(t => !actual.includes(t));
    assert.deepEqual(
      stale,
      [],
      `llms.txt MCP Tools table lists tools that don't exist in the MCP: ${stale.join(", ")}`,
    );
  });

  it("all llms.txt actionable endpoints appear in SURFACE", () => {
    const documented = parseLlmsTxtEndpoints(llmsTxt);
    const surfaceEndpoints = SURFACE
      .filter(c => c.endpoint !== "(local)")
      .map(c => c.endpoint);

    // Informational GET endpoints and auth/REST proxied endpoints that don't need dedicated tools
    const IGNORED_ENDPOINTS = new Set([
      // Tier management
      "GET /tiers/v1",
      // Info/discovery endpoints (return pricing or schema, no action)
      "GET /projects/v1",
      "GET /fork/v1",
      "GET /generate-image/v1",
      "GET /message/v1",
      "GET /agent/v1/contact",
      // Subdomain lookup (covered by list_subdomains)
      "GET /subdomains/v1/:name",
      // REST proxy (covered by rest_query)
      "GET /rest/v1/:table",
      "POST /rest/v1/:table",
      "PATCH /rest/v1/:table",
      "DELETE /rest/v1/:table",
      // Auth (handled client-side, not via MCP/CLI)
      "POST /auth/v1/signup",
      "POST /auth/v1/token",
      "POST /auth/v1/token?grant_type=refresh_token",
      "GET /auth/v1/user",
      "POST /auth/v1/logout",
      // Legacy storage shim — retired 2026-04-28 from the gateway. Upstream
      // llms.txt may still list these until the private repo's docs catch up;
      // ignore them on our side so this test stays green either way.
      "POST /storage/v1/object/:bucket/*",
      "GET /storage/v1/object/:bucket/*",
      "DELETE /storage/v1/object/:bucket/*",
      "GET /storage/v1/object/list/:bucket",
      "POST /storage/v1/object/sign/:bucket/*",
      // Invocation variants (covered by invoke_function)
      "GET /functions/v1/:name",
      "PATCH /functions/v1/:name",
      "DELETE /functions/v1/:name",
      // Auth endpoints (called directly from frontend JS, no CLI/MCP wrapper)
      "GET /auth/v1/providers",
      "POST /auth/v1/oauth/google/start",
      "POST /auth/v1/token?grant_type=authorization_code",
      // Utility endpoints
      "GET /.well-known/x402",
      "GET /ping/v1",
      // Functions discovery (covered by list_functions per-project)
      "GET /functions/v1",
      // Mailbox endpoints not yet exposed as tools
      // GET /mailboxes/v1 is covered by get_mailbox (discovery via list)
      // DELETE /mailboxes/v1/:id is now covered by delete_mailbox — do NOT ignore
      "GET /mailboxes/v1",
      "GET /mailboxes/v1/:id",
      "POST /mailboxes/v1/:id/status",
      // AI add-on management (dashboard-only, not exposed as tools)
      "POST /ai/v1/addons",
      "DELETE /ai/v1/addons",
      // Public storage access (no auth, used via url field from upload response)
      "GET /storage/v1/public/:project_id/:bucket/*",
      // Function trigger is a gateway testing endpoint, not exposed as a tool
      "POST /projects/v1/admin/:id/functions/:name/trigger",
      // Blob upload session internals — driven by blob_put under the hood
      "GET /storage/v1/uploads/{id}",
      "POST /storage/v1/uploads/{id}/complete",
      "DELETE /storage/v1/uploads/{id}",
      // Unified deploy v2 (v1.34+) — internal plumbing for the deploy
      // primitive. The SDK orchestrates plan + upload + commit + poll across
      // these; agents call `deploy.apply` / `deploy.resume` /
      // `deploy.list` / `deploy.events`. The :id snapshot endpoint is exposed
      // as `r.deploy.status()` on the SDK but not as its own MCP/CLI tool.
      "POST /deploy/v2/plans/:id/commit",
      "GET /deploy/v2/operations/:id",
      // CAS content service — internal substrate shared by deploy.apply,
      // blobs.put, and the manifest-ref escape hatch. Not surfaced as its
      // own tool; the SDK uses it transparently.
      "POST /content/v1/plans",
      "POST /content/v1/plans/:id/commit",
    ]);

    const uncovered = documented.filter(ep => {
      if (IGNORED_ENDPOINTS.has(ep)) return false;
      // Check if any SURFACE endpoint matches (normalize param names)
      return !surfaceEndpoints.some(se => {
        // Exact match
        if (se === ep) return true;
        // Match with different param names: normalize :foo and {foo} to :param
        const normDoc = ep.replace(/:[a-z_]+/g, ":param").replace(/\{[a-z_]+\}/g, ":param");
        const normSurf = se.replace(/:[a-z_]+/g, ":param").replace(/\{[a-z_]+\}/g, ":param");
        return normDoc === normSurf;
      });
    });

    assert.deepEqual(
      uncovered,
      [],
      `llms.txt has actionable endpoints not in SURFACE. Add them to the SURFACE array in sync.test.ts or to IGNORED_ENDPOINTS if intentionally excluded: ${uncovered.join(", ")}`,
    );
  });

  it("all SURFACE endpoints appear in llms.txt", () => {
    const missing = SURFACE
      .filter(c => c.endpoint !== "(local)")
      .filter(c => {
        // Strip method prefix and normalize param placeholders for matching.
        // e.g. "POST /v1/projects/:id/renew" → check that "/v1/projects/" and "/renew" appear
        const path = c.endpoint.replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/, "");
        // Direct match
        if (llmsTxt.includes(path)) return false;
        // Match with params stripped (e.g. /admin/v1/projects/:id/functions → /admin/v1/projects/ + /functions)
        const segments = path.split(/\/:[^/]+/);
        return !segments.every(seg => seg === "" || llmsTxt.includes(seg));
      });
    assert.deepEqual(
      missing.map(c => `${c.id}: ${c.endpoint}`),
      [],
      `API endpoints in SURFACE not documented in llms.txt`,
    );
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
