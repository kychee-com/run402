/**
 * sync.test.ts — Ensures the CLI, OpenClaw, and the SDK stay in sync with the
 * Run402 API surface, and pins the MCP server's fixed eight tools.
 *
 * MCP carries no per-capability column: every capability the SDK exposes is
 * reached from MCP through the `run` tool, so the MCP half of this gate is the
 * literal MCP_TOOLS list (exact registration) and a doc-drift check that no
 * public surface names an MCP tool outside it.
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

/**
 * Every tool registration in src/index.ts, as `server.registerTool("name", { ... })`
 * or the older `server.tool("name", ...)`, with whether its config declares an
 * `outputSchema` (the older form cannot).
 */
function parseMcpRegistrations(): Array<{ name: string; outputSchema: boolean }> {
  const src = readFileSync(join(__dirname, "src/index.ts"), "utf-8");
  const out: Array<{ name: string; outputSchema: boolean }> = [];
  const re = /server\.(registerTool|tool)\(\s*\n?\s*"([^"]+)"/g;
  const starts: Array<{ index: number; kind: string; name: string }> = [];
  let m;
  while ((m = re.exec(src))) starts.push({ index: m.index, kind: m[1]!, name: m[2]! });
  starts.forEach((start, i) => {
    const body = src.slice(start.index, starts[i + 1]?.index ?? src.length);
    out.push({ name: start.name, outputSchema: start.kind === "registerTool" && /\boutputSchema\s*:/.test(body) });
  });
  return out;
}

/** The names of every tool registered in src/index.ts. */
function parseMcpTools(): string[] {
  return parseMcpRegistrations().map((r) => r.name).sort();
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

function readCommandSource(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const src = readFileSync(filePath, "utf-8");
  const reExportMatch = src.match(/export\s+\{[^}]*run[^}]*\}\s+from\s+["']([^"']+)["']/);
  if (reExportMatch) {
    return readCommandSource(join(dirname(filePath), reExportMatch[1]));
  }
  return src;
}

/** Parse CLI commands as "module:subcommand" pairs */
function parseCliCommands(): string[] {
  const cmds: string[] = [];
  for (const mod of ["admin", "wallets", "tier", "projects", "snapshots", "branches", "image", "storage", "assets", "cache", "cdn", "functions", "secrets", "jobs", "sites", "subdomains", "domains", "apps", "email", "feedback", "agent", "ai", "auth", "billing", "contracts", "webhooks", "service", "deploy", "ci", "transfer", "orgs", "identity", "buzz", "grants", "deliveries", "contacts", "subscriptions", "webhook-secret", "archives", "rooms", "messages", "claims", "escalations", "repos", "events", "errors"]) {
    for (const sub of parseSubcommands(join(__dirname, "cli/lib", `${mod}.mjs`))) {
      cmds.push(`${mod}:${sub}`);
    }
  }
  for (const action of parseCredentialsRootActions("cli/lib/credentials.mjs")) cmds.push(`credentials:${action}`);
  for (const action of parseCredentialsProjectKeyActions("cli/lib/credentials.mjs")) cmds.push(`credentials:project-keys:${action}`);
  // `buzz notifications` dispatches out of buzz.mjs via `if (sub === "notifications")`
  // into its own module, so its leaves surface here.
  for (const action of parseSubcommands(join(__dirname, "cli/lib/buzz-notifications.mjs"))) cmds.push(`buzz:notifications:${action}`);
  for (const action of parseDeployReleasesActions()) {
    cmds.push(`deploy:releases:${action}`);
  }
  for (const action of parseJobsArtifactsActions()) {
    cmds.push(`jobs:artifacts:${action}`);
  }
  for (const action of parseOrgGroupActions("memberAction")) cmds.push(`orgs:members:${action}`);
  for (const action of parseOrgGroupActions("inviteAction")) cmds.push(`orgs:invite:${action}`);
  // Bare `run402 deploy` is the deploy itself (deploy.mjs dispatches anything
  // that is not a family word into it), so it is a top-level verb here.
  if (existsSync(join(__dirname, "cli/lib/deploy.mjs"))) cmds.push("deploy");
  if (existsSync(join(__dirname, "cli/lib/init.mjs"))) cmds.push("init");
  if (existsSync(join(__dirname, "cli/lib/pay.mjs"))) cmds.push("pay");
  if (existsSync(join(__dirname, "cli/lib/redeem.mjs"))) cmds.push("redeem");
  if (existsSync(join(__dirname, "cli/lib/up.mjs"))) cmds.push("up");
  if (existsSync(join(__dirname, "cli/lib/status.mjs"))) cmds.push("status");
  if (existsSync(join(__dirname, "cli/lib/doctor.mjs"))) cmds.push("doctor");
  if (existsSync(join(__dirname, "cli/lib/live.mjs"))) cmds.push("live");
  if (existsSync(join(__dirname, "cli/lib/dev.mjs"))) cmds.push("dev");
  if (existsSync(join(__dirname, "cli/lib/logs.mjs"))) cmds.push("logs");
  for (const verb of ["login", "logout", "whoami", "approve"]) {
    if (existsSync(join(__dirname, "cli/lib", `${verb}.mjs`))) cmds.push(verb);
  }
  return cmds.sort();
}

/** Parse OpenClaw commands as "module:subcommand" pairs */
function parseOpenClawCommands(): string[] {
  const cmds: string[] = [];
  for (const mod of ["admin", "wallets", "tier", "projects", "snapshots", "branches", "image", "storage", "assets", "cache", "cdn", "functions", "secrets", "jobs", "sites", "subdomains", "domains", "apps", "email", "feedback", "agent", "ai", "auth", "billing", "contracts", "webhooks", "service", "deploy", "ci", "transfer", "orgs", "identity", "buzz", "grants", "deliveries", "contacts", "subscriptions", "webhook-secret", "archives", "rooms", "messages", "claims", "escalations", "repos", "events", "errors"]) {
    for (const sub of parseSubcommands(join(__dirname, "openclaw/scripts", `${mod}.mjs`))) {
      cmds.push(`${mod}:${sub}`);
    }
  }
  for (const action of parseCredentialsRootActions("openclaw/scripts/credentials.mjs")) cmds.push(`credentials:${action}`);
  for (const action of parseCredentialsProjectKeyActions("openclaw/scripts/credentials.mjs")) cmds.push(`credentials:project-keys:${action}`);
  // openclaw/scripts/buzz.mjs re-exports cli/lib/buzz.mjs, so the notifications
  // group is the same module on both surfaces.
  for (const action of parseSubcommands(join(__dirname, "cli/lib/buzz-notifications.mjs"))) cmds.push(`buzz:notifications:${action}`);
  for (const action of parseDeployReleasesActions()) {
    cmds.push(`deploy:releases:${action}`);
  }
  for (const action of parseJobsArtifactsActions()) {
    cmds.push(`jobs:artifacts:${action}`);
  }
  for (const action of parseOrgGroupActions("memberAction")) cmds.push(`orgs:members:${action}`);
  for (const action of parseOrgGroupActions("inviteAction")) cmds.push(`orgs:invite:${action}`);
  if (existsSync(join(__dirname, "openclaw/scripts/deploy.mjs"))) cmds.push("deploy");
  if (existsSync(join(__dirname, "openclaw/scripts/init.mjs"))) cmds.push("init");
  if (existsSync(join(__dirname, "openclaw/scripts/pay.mjs"))) cmds.push("pay");
  if (existsSync(join(__dirname, "openclaw/scripts/redeem.mjs"))) cmds.push("redeem");
  if (existsSync(join(__dirname, "openclaw/scripts/up.mjs"))) cmds.push("up");
  if (existsSync(join(__dirname, "openclaw/scripts/status.mjs"))) cmds.push("status");
  if (existsSync(join(__dirname, "openclaw/scripts/doctor.mjs"))) cmds.push("doctor");
  if (existsSync(join(__dirname, "openclaw/scripts/live.mjs"))) cmds.push("live");
  if (existsSync(join(__dirname, "openclaw/scripts/dev.mjs"))) cmds.push("dev");
  if (existsSync(join(__dirname, "openclaw/scripts/logs.mjs"))) cmds.push("logs");
  for (const verb of ["login", "logout", "whoami", "approve"]) {
    if (existsSync(join(__dirname, "openclaw/scripts", `${verb}.mjs`))) cmds.push(verb);
  }
  return cmds.sort();
}

function parseDeployReleasesActions(): string[] {
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
 *  are matched on `if (action === "...")`, mirroring `deploy releases`. */
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

/**
 * `credentials` has TWO switches — the top-level verbs that act on the
 * gateway's project credentials, and the nested `project-keys` group that acts
 * on the local cache — and they share the names `list` and `status`. So both
 * parsers below are scoped to their own function body; a file-wide scan would
 * report the local cache's `import`/`export`/`remove` as top-level commands.
 * That ambiguity is why this module is special-cased instead of being listed
 * with the generic one-switch modules above.
 */
function credentialsSections(relativePath: string): { projectKeys: string; root: string } {
  const src = readCommandSource(join(__dirname, relativePath)) ?? "";
  const groupAt = src.indexOf("async function runProjectKeys(");
  const rootAt = src.indexOf("export async function run(");
  if (groupAt < 0 || rootAt < 0) return { projectKeys: src, root: "" };
  return { projectKeys: src.slice(groupAt, rootAt), root: src.slice(rootAt) };
}

function caseLabels(section: string): string[] {
  const actions: string[] = [];
  const re = /case\s+"([\w-]+)":/g;
  let m;
  while ((m = re.exec(section))) actions.push(m[1]);
  return [...new Set(actions)].sort();
}

function parseCredentialsProjectKeyActions(relativePath: string): string[] {
  return caseLabels(credentialsSections(relativePath).projectKeys);
}

/** The gateway-facing verbs: issue / list / status / rotate / revoke / token. */
function parseCredentialsRootActions(relativePath: string): string[] {
  return caseLabels(credentialsSections(relativePath).root);
}

/** Parse the nested `org member <action>` / `org invite <action>` leaf actions
 *  from cli/lib/orgs.mjs (matched on `memberAction === "..."` / `inviteAction ===
 *  "..."`), mirroring `jobs artifacts`. The groups dispatch via `if (sub === ...)`
 *  so parseSubcommands skips them; these surface their leaves instead. */
function parseOrgGroupActions(varName: "memberAction" | "inviteAction"): string[] {
  const filePath = join(__dirname, "cli/lib/orgs.mjs");
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
  /** Expected CLI command as "module:sub" or "module", or null */
  cli: string | null;
  /** Expected OpenClaw command (must match CLI if both non-null) */
  openclaw: string | null;
}

const SURFACE: Capability[] = [
  // ── Init / status (local-only) ──────────────────────────────────────────
  { id: "up",                endpoint: "(compound local+gateway action)",       cli: "up",                  openclaw: "up" },
  { id: "init",              endpoint: "(local)",                              cli: "init",                openclaw: "init" },
  { id: "pay_url",           endpoint: "(external x402 URL)",                  cli: "pay",                 openclaw: "pay" },
  // Redeeming is on every surface on purpose: a promo code can arrive in a
  // pasted prompt to a shell agent, an MCP client (a `run` snippet), or a
  // human's OpenClaw session, and the code is worthless to whichever one cannot use it.
  { id: "redeem_voucher",    endpoint: "POST /vouchers/v1/redemptions",        cli: "redeem",              openclaw: "redeem" },
  { id: "status",            endpoint: "(local)",                              cli: "status",              openclaw: "status" },
  // The CLI/OpenClaw group hands public content to Buzz's signer boundary and
  // never accepts a Nostr secret.
  { id: "identity_links",    endpoint: "/identity-links/v1 + /identity-link-proofs/v1/:id", cli: "identity:link", openclaw: "identity:link" },
  // Status and every mutation preserve an exact CLI/SDK handoff without
  // collecting Nostr private keys.
  { id: "buzz_status",       endpoint: "GET /agent/v1/whoami",                               cli: "buzz:status",  openclaw: "buzz:status" },
  // The one goal-shaped `buzz adopt` command owns the canonical offer flow and
  // its explicitly advanced direct-adoption compatibility path.
  { id: "buzz_adopt",        endpoint: "/buzz-human-adoption-offers/v1 + /buzz-human-adoptions/v1", cli: "buzz:adopt", openclaw: "buzz:adopt" },
  { id: "buzz_install",      endpoint: "/buzz-community-installations/v1",                    cli: "buzz:install", openclaw: "buzz:install" },
  { id: "buzz_enroll",       endpoint: "/buzz-agent-enrollments/v1",                          cli: "buzz:enroll",  openclaw: "buzz:enroll" },
  { id: "buzz_join",         endpoint: "/buzz-community-installations/v1/:id/teammates",      cli: "buzz:join",    openclaw: "buzz:join" },
  { id: "buzz_approve",      endpoint: "POST /buzz-agent-enrollments/v1/:id/approve",          cli: "buzz:approve", openclaw: "buzz:approve" },
  { id: "buzz_deny",         endpoint: "POST /buzz-agent-enrollments/v1/:id/deny",             cli: "buzz:deny",    openclaw: "buzz:deny" },
  { id: "buzz_revoke",       endpoint: "DELETE /buzz-agent-enrollments/v1/:id",                cli: "buzz:revoke",  openclaw: "buzz:revoke" },
  // Project-event routing into a Buzz channel (add-buzz-project-event-routing).
  // Mutations need owner step-up and the authorization handoff on the CLI/SDK
  // boundary; the two reads answer "is the route healthy / did the delivery
  // land", and neither response carries credential material.
  { id: "buzz_notify_configure",  endpoint: "POST /buzz-project-event-routes/v1",                       cli: "buzz:notifications:configure",  openclaw: "buzz:notifications:configure" },
  // One surface member covers both reads on each side: the CLI's `status`
  // takes either --org (list) or a route id (get), and get_buzz_route with the
  // route id omitted lists (the get_escalation precedent — the agent's loop is
  // "check MY route"). The list row carries the CLI command and the get row
  // the SDK read, so neither inventory double-counts.
  { id: "buzz_notify_list",       endpoint: "GET /buzz-project-event-routes/v1?org_id=...",             cli: "buzz:notifications:status",     openclaw: "buzz:notifications:status" },
  { id: "buzz_notify_get",        endpoint: "GET /buzz-project-event-routes/v1/:id",                    cli: null, openclaw: null },
  { id: "buzz_notify_test",       endpoint: "POST /buzz-project-event-routes/v1/:id/test",              cli: "buzz:notifications:test",       openclaw: "buzz:notifications:test" },
  { id: "buzz_notify_deliveries", endpoint: "GET /buzz-project-event-routes/v1/:id/deliveries",         cli: "buzz:notifications:deliveries", openclaw: "buzz:notifications:deliveries" },
  { id: "buzz_notify_pause",      endpoint: "POST /buzz-project-event-routes/v1/:id/pause",             cli: "buzz:notifications:pause",      openclaw: "buzz:notifications:pause" },
  { id: "buzz_notify_resume",     endpoint: "POST /buzz-project-event-routes/v1/:id/resume",            cli: "buzz:notifications:resume",     openclaw: "buzz:notifications:resume" },
  { id: "buzz_notify_rotate",     endpoint: "POST /buzz-project-event-routes/v1/:id/rotate",            cli: "buzz:notifications:rotate",     openclaw: "buzz:notifications:rotate" },
  { id: "buzz_notify_revoke",     endpoint: "DELETE /buzz-project-event-routes/v1/:id",                 cli: "buzz:notifications:revoke",     openclaw: "buzz:notifications:revoke" },
  // The one PATCH verb with a CLI spelling: set/clear the agent a crash or
  // incident pages. The rest of the PATCH surface stays SDK-only.
  { id: "buzz_notify_on_call",    endpoint: "PATCH /buzz-project-event-routes/v1/:id",                  cli: "buzz:notifications:on-call",    openclaw: "buzz:notifications:on-call" },
  // The scope verb: a route names its projects explicitly, so a project an
  // agent provisions later is added here (same PATCH, project_ids).
  { id: "buzz_notify_projects",   endpoint: "PATCH /buzz-project-event-routes/v1/:id",                  cli: "buzz:notifications:projects",   openclaw: "buzz:notifications:projects" },
  { id: "buzz_notify_scope",      endpoint: "PATCH /buzz-project-event-routes/v1/:id",                  cli: "buzz:notifications:scope",      openclaw: "buzz:notifications:scope" },

  // ── Named wallets / profiles (local-only management; selection via --wallet) ─
  { id: "wallets_list",      endpoint: "(local)",                              cli: "wallets:list",     openclaw: "wallets:list" },
  { id: "wallets_current",   endpoint: "(local)",                              cli: "wallets:current",  openclaw: "wallets:current" },
  { id: "wallets_new",       endpoint: "(local)",                              cli: "wallets:new",      openclaw: "wallets:new" },
  { id: "wallets_use",       endpoint: "(local)",                              cli: "wallets:use",      openclaw: "wallets:use" },
  { id: "wallets_rename",    endpoint: "(local)",                              cli: "wallets:rename",   openclaw: "wallets:rename" },
  { id: "wallets_bind",      endpoint: "(local)",                              cli: "wallets:bind",     openclaw: "wallets:bind" },
  { id: "wallets_unbind",    endpoint: "(local)",                              cli: "wallets:unbind",   openclaw: "wallets:unbind" },
  { id: "wallets_import",    endpoint: "(local)",                              cli: "wallets:import",   openclaw: "wallets:import" },
  { id: "wallets_rm",        endpoint: "(local)",                              cli: "wallets:rm",       openclaw: "wallets:rm" },

  // ── SSR Runtime DX (v1.52, local-only / CLI-only) ──────────────────────
  // doctor / dev / logs are agent-DX shortcuts: CLI parity with OpenClaw.
  { id: "doctor",            endpoint: "(local)",                              cli: "doctor",              openclaw: "doctor" },
  { id: "dev",               endpoint: "(local)",                              cli: "dev",                 openclaw: "dev" },
  { id: "logs",              endpoint: "GET /functions/v1/:name/logs (filtered)", cli: "logs",                openclaw: "logs" },

  // ── SSR origin cache (v1.52) ────────────────────────────────────────────
  { id: "cache_invalidate",  endpoint: "POST /cache/v1/invalidate",            cli: "cache:invalidate",    openclaw: "cache:invalidate" },
  { id: "cache_inspect",     endpoint: "GET /cache/v1/inspect",                cli: "cache:inspect",       openclaw: "cache:inspect" },

  // ── Project lifecycle ────────────────────────────────────────────────────
  { id: "get_quote",         endpoint: "POST /projects/v1/quote",                cli: "projects:quote",      openclaw: "projects:quote" },
  { id: "provision",         endpoint: "POST /projects/v1",                      cli: "projects:provision",  openclaw: "projects:provision" },
  { id: "tier_set",           endpoint: "POST /tiers/v1/:tier",                   cli: "tier:set",            openclaw: "tier:set" },
  { id: "delete",            endpoint: "DELETE /projects/v1/:id",                cli: "projects:delete",     openclaw: "projects:delete" },
  { id: "export_project_archive", endpoint: "POST /projects/v1/:project_id/archives", cli: "archives:create", openclaw: "archives:create" },
  { id: "download_project_archive", endpoint: "GET /projects/v1/:project_id/archives/:archive_id/download", cli: "archives:download", openclaw: "archives:download" },
  { id: "get_project_archive", endpoint: "GET /projects/v1/:project_id/archives/:archive_id", cli: "archives:status", openclaw: "archives:status" },
  { id: "inspect_project_archive", endpoint: "(local archive inspect)", cli: "archives:inspect", openclaw: "archives:inspect" },
  { id: "verify_project_archive", endpoint: "(local archive verify)", cli: "archives:verify", openclaw: "archives:verify" },
  { id: "import_project_archive", endpoint: "POST /archives/v1/import (Run402 Core)", cli: "archives:import", openclaw: "archives:import" },
  { id: "create_project_snapshot", endpoint: "POST /projects/v1/:project_id/snapshots", cli: "snapshots:create", openclaw: "snapshots:create" },
  { id: "list_project_snapshots", endpoint: "GET /projects/v1/:project_id/snapshots", cli: "snapshots:list", openclaw: "snapshots:list" },
  { id: "get_project_snapshot", endpoint: "GET /projects/v1/:project_id/snapshots/:snapshot_id", cli: "snapshots:get", openclaw: "snapshots:get" },
  { id: "restore_project_snapshot", endpoint: "POST /projects/v1/:project_id/snapshots/:snapshot_id/restore", cli: "snapshots:restore", openclaw: "snapshots:restore" },
  { id: "delete_project_snapshot", endpoint: "DELETE /projects/v1/:project_id/snapshots/:snapshot_id", cli: "snapshots:delete", openclaw: "snapshots:delete" },
  { id: "create_project_branch", endpoint: "POST /projects/v1/:project_id/branches", cli: "branches:create", openclaw: "branches:create" },
  { id: "list_project_branches", endpoint: "GET /projects/v1/:project_id/branches", cli: "branches:list", openclaw: "branches:list" },
  { id: "renew_project_branch", endpoint: "POST /projects/v1/:project_id/branches/:branch_project_id/renew", cli: "branches:renew", openclaw: "branches:renew" },
  { id: "delete_project_branch", endpoint: "DELETE /projects/v1/:project_id/branches/:branch_project_id", cli: "branches:delete", openclaw: "branches:delete" },

  // ── Faucet ───────────────────────────────────────────────────────────────
  { id: "faucet",            endpoint: "POST /faucet/v1",                        cli: "wallets:fund",        openclaw: "wallets:fund" },

  // ── Database / Admin ─────────────────────────────────────────────────────
  { id: "run_sql",           endpoint: "POST /projects/v1/:project_id/sql",      cli: "projects:sql",        openclaw: "projects:sql" },
  // Reached through `run402 projects sql --batch <path>`; the command is run_sql's.
  { id: "run_sql_batch",     endpoint: "POST /projects/v1/:project_id/sql/batch", cli: null,                openclaw: null },
  { id: "rest_query",        endpoint: "/rest/v1/:table",                        cli: "projects:rest",       openclaw: "projects:rest" },
  { id: "apply_expose",      endpoint: "POST /projects/v1/admin/:id/expose",     cli: "projects:apply-expose", openclaw: "projects:apply-expose" },
  { id: "validate_manifest", endpoint: "POST /projects/v1/expose/validate",      cli: "projects:validate-expose", openclaw: "projects:validate-expose" },
  { id: "get_expose",        endpoint: "GET /projects/v1/admin/:id/expose",      cli: "projects:get-expose",   openclaw: "projects:get-expose" },
  { id: "get_schema",        endpoint: "GET /projects/v1/admin/:id/schema",      cli: "projects:schema",     openclaw: "projects:schema" },
  { id: "get_usage",         endpoint: "GET /projects/v1/admin/:id/usage",       cli: "projects:usage",      openclaw: "projects:usage" },

  // ── Assets (direct-to-S3 storage, v1.48 unified-apply rename of blobs) ──
  { id: "assets_put",        endpoint: "POST /apply/v1/plans",                   cli: "assets:put",       openclaw: "assets:put" },
  { id: "assets_get",        endpoint: "GET /storage/v1/blob/{key}",             cli: "assets:get",       openclaw: "assets:get" },
  { id: "assets_ls",         endpoint: "GET /storage/v1/blobs",                  cli: "assets:ls",        openclaw: "assets:ls" },
  { id: "assets_rm",         endpoint: "DELETE /storage/v1/blob/{key}",          cli: "assets:rm",        openclaw: "assets:rm" },
  { id: "assets_sign",       endpoint: "POST /storage/v1/blob/{key}/sign",       cli: "assets:sign",      openclaw: "assets:sign" },
  // v1.45: agent-DX CDN diagnostics for asset URLs (CLI: assets diagnose / cdn wait-fresh).
  { id: "diagnose_public_url",   endpoint: "GET /storage/v1/blobs/diagnose",       cli: "assets:diagnose",   openclaw: "assets:diagnose" },
  { id: "wait_for_cdn_freshness", endpoint: "GET /storage/v1/blobs/diagnose (poll)", cli: "cdn:wait-fresh",    openclaw: "cdn:wait-fresh" },

  // ── Functions ────────────────────────────────────────────────────────────
  { id: "deploy_function",   endpoint: "POST /apply/v1/plans (functions.patch.set)",          cli: "functions:deploy", openclaw: "functions:deploy" },
  { id: "invoke_function",   endpoint: "POST /functions/v1/:name",                            cli: "functions:invoke", openclaw: "functions:invoke" },
  { id: "get_function_logs", endpoint: "GET /projects/v1/admin/:id/functions/:name/logs",    cli: "functions:logs",   openclaw: "functions:logs" },
  { id: "list_functions",    endpoint: "GET /projects/v1/admin/:id/functions",                cli: "functions:list",   openclaw: "functions:list" },
  { id: "delete_function",   endpoint: "DELETE /projects/v1/admin/:id/functions/:name",      cli: "functions:delete", openclaw: "functions:delete" },
  { id: "update_function",   endpoint: "PATCH /projects/v1/admin/:id/functions/:name",     cli: "functions:update", openclaw: "functions:update" },
  // function-runtime-rebuild (v1.69): opt-in refresh onto the current platform
  // runtime. The CLI `functions rebuild [name] [--all]` collapses the single
  // (`:name/rebuild`) and project-wide (`/rebuild`) endpoints into one verb;
  // the batch SDK method is in SDK_ONLY_METHODS.
  { id: "rebuild_function",  endpoint: "POST /projects/v1/:id/functions/:name/rebuild",     cli: "functions:rebuild", openclaw: "functions:rebuild" },
  // durable-function-requests: one CLI/OpenClaw `functions runs <action>` group
  // maps to six typed SDK methods.
  { id: "create_function_run", endpoint: "POST /functions/v1/:name/runs",        cli: "functions:runs", openclaw: "functions:runs" },
  { id: "list_function_runs",  endpoint: "GET /functions/v1/:name/runs",         cli: null, openclaw: null },
  { id: "get_function_run",    endpoint: "GET /functions/v1/runs/:run_id",       cli: null, openclaw: null },
  { id: "get_function_run_logs", endpoint: "GET /functions/v1/runs/:run_id/logs", cli: null, openclaw: null },
  { id: "cancel_function_run", endpoint: "POST /functions/v1/runs/:run_id/cancel", cli: null, openclaw: null },
  { id: "redrive_function_run", endpoint: "POST /functions/v1/runs/:run_id/redrive", cli: null, openclaw: null },

  // ── Secrets ──────────────────────────────────────────────────────────────
  { id: "set_secret",        endpoint: "POST /projects/v1/admin/:id/secrets",        cli: "secrets:set",    openclaw: "secrets:set" },
  { id: "list_secrets",      endpoint: "GET /projects/v1/admin/:id/secrets",         cli: "secrets:list",   openclaw: "secrets:list" },
  { id: "delete_secret",     endpoint: "DELETE /projects/v1/admin/:id/secrets/:key", cli: "secrets:delete", openclaw: "secrets:delete" },

  // ── Managed jobs ────────────────────────────────────────────────────────
  { id: "jobs_submit",       endpoint: "POST /jobs/v1/runs",                 cli: "jobs:submit", openclaw: "jobs:submit" },
  { id: "jobs_get",          endpoint: "GET /jobs/v1/runs/:job_id",          cli: "jobs:get",    openclaw: "jobs:get" },
  { id: "jobs_logs",         endpoint: "GET /jobs/v1/runs/:job_id/logs",     cli: "jobs:logs",   openclaw: "jobs:logs" },
  { id: "jobs_cancel",       endpoint: "DELETE /jobs/v1/runs/:job_id",       cli: "jobs:cancel", openclaw: "jobs:cancel" },
  { id: "jobs_purge",        endpoint: "DELETE /jobs/v1/runs",               cli: "jobs:purge",  openclaw: "jobs:purge" },
  { id: "jobs_download_artifact", endpoint: "GET /jobs/v1/runs/:job_id/artifacts/:filename", cli: "jobs:artifacts:get", openclaw: "jobs:artifacts:get" },

  // ── Sites / Subdomains ───────────────────────────────────────────────────
  { id: "deploy_site",       endpoint: "POST /apply/v1/plans",             cli: "sites:deploy",       openclaw: "sites:deploy" },
  { id: "deploy_site_dir",   endpoint: "POST /apply/v1/plans",             cli: "sites:deploy-dir",   openclaw: "sites:deploy-dir" },
  { id: "add_subdomain",   endpoint: "POST /subdomains/v1",              cli: "subdomains:add",   openclaw: "subdomains:add" },
  { id: "delete_subdomain",  endpoint: "DELETE /subdomains/v1/:name",      cli: "subdomains:delete",  openclaw: "subdomains:delete" },
  { id: "list_subdomains",   endpoint: "GET /subdomains/v1",               cli: "subdomains:list",    openclaw: "subdomains:list" },

  // ── Project domains ─────────────────────────────────────────────────────
  { id: "domains_connect",      endpoint: "POST /projects/v1/:project_id/domains",              cli: "domains:connect",      openclaw: "domains:connect" },
  { id: "domains_list",         endpoint: "GET /projects/v1/:project_id/domains",               cli: "domains:list",         openclaw: "domains:list" },
  { id: "domains_get",          endpoint: "GET /projects/v1/:project_id/domains/:domain",       cli: "domains:status",       openclaw: "domains:status" },
  { id: "domains_dns",          endpoint: "GET /projects/v1/:project_id/domains/:domain",       cli: "domains:dns",          openclaw: "domains:dns" },
  { id: "domains_check",        endpoint: "POST /projects/v1/:project_id/domains/:domain/actions/check", cli: "domains:check",        openclaw: "domains:check" },
  { id: "domains_apply",        endpoint: "POST /projects/v1/:project_id/domains/:domain/actions/apply", cli: "domains:apply",        openclaw: "domains:apply" },
  { id: "domains_repair",       endpoint: "POST /projects/v1/:project_id/domains/:domain/actions/repair", cli: "domains:repair",      openclaw: "domains:repair" },
  { id: "domains_test_receive", endpoint: "POST /projects/v1/:project_id/domains/:domain/actions/test_receive", cli: "domains:test-receive", openclaw: "domains:test-receive" },
  { id: "domains_wait",         endpoint: "POST /projects/v1/:project_id/domains/:domain/actions/check (poll)", cli: "domains:wait", openclaw: "domains:wait" },
  { id: "domains_activate",     endpoint: "POST /projects/v1/:project_id/domains/:domain/actions/activate_mailbox_addresses", cli: "domains:activate", openclaw: "domains:activate" },
  { id: "domains_disconnect",   endpoint: "DELETE /projects/v1/:project_id/domains/:domain",    cli: "domains:disconnect",   openclaw: "domains:disconnect" },

  // ── Unified apply ────────────────────────────────────────────────────────
  { id: "deploy",            endpoint: "POST /apply/v1/plans",                            cli: "deploy",            openclaw: "deploy" },
  { id: "deploy_rehearse",   endpoint: "POST /apply/v1/plans/:plan_id/rehearse",           cli: "deploy:rehearse",   openclaw: "deploy:rehearse" },
  { id: "deploy_resume",     endpoint: "POST /apply/v1/operations/:operation_id/resume",            cli: "deploy:resume",     openclaw: "deploy:resume" },
  { id: "deploy_status",     endpoint: "GET /apply/v1/operations/:operation_id",                    cli: "deploy:status",     openclaw: "deploy:status" },
  { id: "deploy_promote",    endpoint: "POST /apply/v1/releases/:release_id/promote",              cli: "deploy:promote",    openclaw: "deploy:promote" },
  { id: "deploy_list",       endpoint: "GET /apply/v1/operations",                        cli: "deploy:list",       openclaw: "deploy:list" },
  { id: "deploy_events",     endpoint: "GET /apply/v1/operations/:operation_id/events",             cli: "deploy:events",     openclaw: "deploy:events" },
  { id: "deploy_verify_edge", endpoint: "GET /apply/v1/operations/:operation_id/edge-coherence",     cli: "deploy:verify",     openclaw: "deploy:verify" },
  { id: "deploy_releases_get",    endpoint: "GET /apply/v1/releases/:release_id",         cli: "deploy:releases:get",    openclaw: "deploy:releases:get" },
  { id: "deploy_releases_active", endpoint: "GET /apply/v1/releases/active",              cli: "deploy:releases:active", openclaw: "deploy:releases:active" },
  { id: "deploy_releases_diff",   endpoint: "GET /apply/v1/releases/diff",                cli: "deploy:releases:diff",   openclaw: "deploy:releases:diff" },
  { id: "deploy_resolve",         endpoint: "GET /apply/v1/resolve",                      cli: "deploy:resolve",         openclaw: "deploy:resolve" },

  // ── CI/OIDC federation ──────────────────────────────────────────────────
  { id: "ci_link_github",    endpoint: "POST /ci/v1/bindings",                              cli: "ci:link",          openclaw: "ci:link" },
  { id: "ci_list_bindings",  endpoint: "GET /ci/v1/bindings",                               cli: "ci:list",          openclaw: "ci:list" },
  { id: "ci_get_binding",    endpoint: "GET /ci/v1/bindings/:id",                           cli: null,               openclaw: null },
  { id: "ci_revoke_binding", endpoint: "POST /ci/v1/bindings/:id/revoke",                   cli: "ci:revoke",        openclaw: "ci:revoke" },
  { id: "ci_set_asset_scopes", endpoint: "POST /ci/v1/bindings/:id/asset-scopes",            cli: "ci:set-asset-scopes", openclaw: "ci:set-asset-scopes" },

  // ── Marketplace ──────────────────────────────────────────────────────────
  { id: "browse_apps",       endpoint: "GET /apps/v1",                              cli: "apps:browse",   openclaw: "apps:browse" },
  { id: "fork_app",          endpoint: "POST /fork/v1",                             cli: "apps:fork",     openclaw: "apps:fork" },
  { id: "publish_app",       endpoint: "POST /projects/v1/admin/:id/publish",       cli: "apps:publish",  openclaw: "apps:publish" },
  { id: "list_versions",     endpoint: "GET /projects/v1/admin/:id/versions",       cli: "apps:versions", openclaw: "apps:versions" },

  // ── Billing ──────────────────────────────────────────────────────────────
  { id: "check_balance",     endpoint: "GET /orgs/v1/lookup?wallet=",           cli: "wallets:balance", openclaw: "wallets:balance" },
  { id: "list_projects",     endpoint: "GET /projects/v1",                           cli: "projects:list",  openclaw: "projects:list" },
  { id: "list_tenant_payments", endpoint: "GET /projects/v1/:project_id/tenant-payments", cli: "projects:tenant-payments", openclaw: "projects:tenant-payments" },
  { id: "rename_project",    endpoint: "PATCH /projects/v1/:project_id",             cli: "projects:rename", openclaw: "projects:rename" },
  { id: "project_get",       endpoint: "GET /projects/v1/:project_id",               cli: "projects:get",   openclaw: "projects:get" },
  { id: "project_info_local", endpoint: "(local credential cache; CLI: credentials project-keys)", cli: null, openclaw: null },
  { id: "project_use",       endpoint: "GET /projects/v1/:project_id + local active state", cli: "projects:use", openclaw: "projects:use" },
  { id: "project_keys_local", endpoint: "(local credential cache; CLI: credentials project-keys)", cli: null, openclaw: null },
  { id: "project_current",   endpoint: "(local active-project state)",               cli: "projects:current", openclaw: "projects:current" },
  { id: "project_key_cache_list",   endpoint: "(local credential cache)",            cli: "credentials:project-keys:list",   openclaw: "credentials:project-keys:list" },
  { id: "project_key_cache_status", endpoint: "(local credential cache)",            cli: "credentials:project-keys:status", openclaw: "credentials:project-keys:status" },
  { id: "project_key_cache_import", endpoint: "(local credential cache)",            cli: "credentials:project-keys:import", openclaw: "credentials:project-keys:import" },
  { id: "project_key_cache_export", endpoint: "(local credential cache)",            cli: "credentials:project-keys:export", openclaw: "credentials:project-keys:export" },
  { id: "project_key_cache_remove", endpoint: "(local credential cache)",            cli: "credentials:project-keys:remove", openclaw: "credentials:project-keys:remove" },

  // ── Image generation ─────────────────────────────────────────────────────
  { id: "generate_image",    endpoint: "POST /generate-image/v1",           cli: "image:generate",   openclaw: "image:generate" },

  // ── Email ──────────────────────────────────────────────────────────────
  { id: "create_mailbox",  endpoint: "POST /mailboxes/v1",                      cli: "email:create",  openclaw: "email:create" },
  { id: "list_mailboxes",  endpoint: "GET /mailboxes/v1",                       cli: "email:mailboxes", openclaw: "email:mailboxes" },
  { id: "set_mailbox_defaults", endpoint: "PATCH /mailboxes/v1/settings",        cli: "email:defaults", openclaw: "email:defaults" },
  { id: "update_mailbox",  endpoint: "PATCH /mailboxes/v1/:mailbox_id",          cli: "email:update",  openclaw: "email:update" },
  { id: "send_email",      endpoint: "POST /mailboxes/v1/:mailbox_id/messages",         cli: "email:send",    openclaw: "email:send" },
  { id: "list_emails",     endpoint: "GET /mailboxes/v1/:mailbox_id/messages",          cli: "email:list",    openclaw: "email:list" },
  { id: "get_email",       endpoint: "GET /mailboxes/v1/:mailbox_id/messages/:message_id",   cli: "email:get",     openclaw: "email:get" },
  { id: "get_email_raw",   endpoint: "GET /mailboxes/v1/:mailbox_id/messages/:message_id/raw", cli: "email:get-raw", openclaw: "email:get-raw" },
  { id: "get_mailbox",     endpoint: "GET /mailboxes/v1",                        cli: "email:info",    openclaw: "email:info" },
  { id: "delete_mailbox",  endpoint: "DELETE /mailboxes/v1/:mailbox_id",                 cli: "email:delete",  openclaw: "email:delete" },
  { id: "reply_email",     endpoint: "POST /mailboxes/v1/:mailbox_id/messages",          cli: "email:reply",   openclaw: "email:reply" },

  // ── Mailbox webhooks ──────────────────────────────────────────────────
  { id: "register_mailbox_webhook", endpoint: "POST /mailboxes/v1/:mailbox_id/webhooks",              cli: "webhooks:register", openclaw: "webhooks:register" },
  { id: "list_mailbox_webhooks",    endpoint: "GET /mailboxes/v1/:mailbox_id/webhooks",               cli: "webhooks:list",     openclaw: "webhooks:list" },
  { id: "get_mailbox_webhook",      endpoint: "GET /mailboxes/v1/:mailbox_id/webhooks/:webhook_id",   cli: "webhooks:get",      openclaw: "webhooks:get" },
  { id: "delete_mailbox_webhook",   endpoint: "DELETE /mailboxes/v1/:mailbox_id/webhooks/:webhook_id", cli: "webhooks:delete",   openclaw: "webhooks:delete" },
  { id: "update_mailbox_webhook",   endpoint: "PATCH /mailboxes/v1/:mailbox_id/webhooks/:webhook_id", cli: "webhooks:update",   openclaw: "webhooks:update" },
  { id: "list_mailbox_webhook_deliveries", endpoint: "GET /mailboxes/v1/:mailbox_id/webhooks/deliveries", cli: "webhooks:deliveries", openclaw: "webhooks:deliveries" },
  { id: "redrive_mailbox_webhook_delivery", endpoint: "POST /mailboxes/v1/:mailbox_id/webhooks/deliveries/:delivery_id/redrive", cli: "webhooks:redrive", openclaw: "webhooks:redrive" },

  // ── AI ──────────────────────────────────────────────────────────────────
  { id: "ai_translate",    endpoint: "POST /ai/v1/translate",      cli: "ai:translate",  openclaw: "ai:translate" },
  { id: "ai_moderate",     endpoint: "POST /ai/v1/moderate",       cli: "ai:moderate",   openclaw: "ai:moderate" },
  { id: "ai_usage",        endpoint: "GET /ai/v1/usage",           cli: "ai:usage",      openclaw: "ai:usage" },

  // ── Messaging & agent contact ──────────────────────────────────────────
  { id: "send_feedback",      endpoint: "POST /feedback/v1",                 cli: "feedback:send",     openclaw: "feedback:send" },
  { id: "set_agent_contact", endpoint: "POST /agent/v1/contact",            cli: "agent:contact",    openclaw: "agent:contact" },
  { id: "get_agent_contact_status", endpoint: "GET /agent/v1/contact/status", cli: "agent:status", openclaw: "agent:status" },
  { id: "verify_agent_contact_email", endpoint: "POST /agent/v1/contact/verify-email", cli: "agent:verify-email", openclaw: "agent:verify-email" },
  { id: "start_contact_passkey_enrollment", endpoint: "POST /agent/v1/contact/passkey/enroll", cli: "agent:passkey", openclaw: "agent:passkey" },

  // ── Owner notifications (v1.55) ────────────────────────────────────────
  { id: "list_notifications",           endpoint: "GET /agent/v1/notifications",                   cli: "deliveries:list",            openclaw: "deliveries:list" },
  { id: "get_notification",             endpoint: "GET /agent/v1/notifications/:id",               cli: "deliveries:get",             openclaw: "deliveries:get" },
  { id: "get_notification_preferences", endpoint: "GET /agent/v1/notifications/preferences",       cli: "contacts:preferences",     openclaw: "contacts:preferences" },
  // CLI surfaces both get + set under one `notifications preferences` command
  // (positional `set k=v...`); the SDK keeps the read and write as separate methods.
  { id: "set_notification_preferences", endpoint: "PATCH /agent/v1/notifications/preferences",     cli: null,                            openclaw: null },
  { id: "test_notification",            endpoint: "POST /agent/v1/notifications/test",             cli: "contacts:test",                 openclaw: "contacts:test" },
  { id: "rotate_webhook_secret",        endpoint: "POST /agent/v1/webhook-secret/rotate",          cli: "webhook-secret:rotate",         openclaw: "webhook-secret:rotate" },

  // ── Telegram notification channel + routing rules
  //    (notification-channel-routing-telegram) ─────────────────────────────
  // `connect` blocks on a human tapping a Telegram deep link out-of-band (the
  // CLI polls).
  { id: "connect_telegram_channel", endpoint: "POST /agent/v1/notifications/channels/telegram",              cli: "contacts:connect", openclaw: "contacts:connect" },
  { id: "list_notification_channels", endpoint: "GET /agent/v1/notifications/channels",                      cli: "contacts:list",    openclaw: "contacts:list" },
  { id: "revoke_telegram_channel",  endpoint: "DELETE /agent/v1/notifications/channels/telegram/:binding_id", cli: "contacts:rm",     openclaw: "contacts:rm" },
  { id: "list_notification_rules",  endpoint: "GET /agent/v1/notifications/rules",                           cli: "subscriptions:list",       openclaw: "subscriptions:list" },
  { id: "create_notification_rule", endpoint: "POST /agent/v1/notifications/rules",                          cli: "subscriptions:add",        openclaw: "subscriptions:add" },
  // update_notification_rule (PATCH .../rules/:rule_id) is SDK-typed only in
  // v1 (admin.rules.update) — no CLI verb; see SDK_ONLY_METHODS.
  { id: "delete_notification_rule", endpoint: "DELETE /agent/v1/notifications/rules/:rule_id",               cli: "subscriptions:rm",         openclaw: "subscriptions:rm" },

  // ── Project events feed (project-events-outbox) ─────────────────────────
  // One CLI command covers both scopes: the org-wide union
  // (GET /orgs/v1/:org_id/events) is the same surface addressed with
  // --org / org_id; the SDK's events.listForOrg is tracked in SDK_ONLY_METHODS.
  { id: "list_project_events",          endpoint: "GET /projects/v1/:id/events",                   cli: "events:list",                   openclaw: "events:list" },
  // tenant-live-changes: a long-lived stream has no verb of its own (see the
  // change design); the held read is the polling-friendly shape.
  { id: "live_changes",                 endpoint: "GET /live/v1 + GET /live/v1/changes (+ /_run402/live* on tenant hosts)", cli: "live", openclaw: "live" },

  // ── Agent messaging — coordination rooms (add-agent-messaging) ──────────
  // One CLI family per resource: `rooms` (the room itself: list/get/join/
  // leave), `messages` (the messages in it: send/list/get/ack) and `claims`.
  // join_room folds presence-register + who + claims into the single arrival
  // call; read_room_messages folds list + get-one (message_id param).
  // Org-scoped addressing (org_id + room_key) and the default-room
  // resolution (rooms.forProject) ride the same tools/commands.
  // add-room-invite: `run402 rooms join` is ONE CLI verb with two forms — no
  // positional registers a presence (the route below); a `kri1_…` positional
  // redeems the key FIRST (`POST /rooms/v1/invites/:invite_id/redeem`,
  // x402-paid, folded in the same way `login`'s endpoint parenthetically
  // names its own second route) and only then arrives. The redemption's own SDK
  // method (`rooms.join`) has no capability row of its own — same law as
  // `session.devicePoll` sharing the `login` verb — see SDK_ONLY_METHODS.
  { id: "join_room",                    endpoint: "POST /orgs/v1/:org_id/rooms/:room_key/presences (+ POST /rooms/v1/invites/:invite_id/redeem)", cli: "rooms:join", openclaw: "rooms:join" },
  { id: "leave_room",                   endpoint: "DELETE /orgs/v1/:org_id/rooms/:room_key/presences/:presence_id", cli: "rooms:leave", openclaw: "rooms:leave" },
  // Rooms are derived from use: list_rooms enumerates the rooms a credential
  // can reach, get_room inspects one WITHOUT joining it (an unused key reads
  // as empty, never 404).
  { id: "list_rooms",                   endpoint: "GET /orgs/v1/:org_id/rooms", cli: "rooms:list", openclaw: "rooms:list" },
  { id: "get_room",                     endpoint: "GET /orgs/v1/:org_id/rooms/:room_key", cli: "rooms:get", openclaw: "rooms:get" },
  { id: "send_room_message",            endpoint: "POST /orgs/v1/:org_id/rooms/:room_key/messages", cli: "messages:send", openclaw: "messages:send" },
  { id: "read_room_messages",           endpoint: "GET /orgs/v1/:org_id/rooms/:room_key/messages", cli: "messages:list", openclaw: "messages:list" },
  // kygit-invite design D6/D7: the agent's ear — a blocking wait built on
  // the SAME read route as read_room_messages, held query parameter `wait`.
  // The SDK's `rooms.waitForMessages` owns the loop; `listMessages` takes
  // `wait` for one held read.
  { id: "messages_wait",                endpoint: "GET /orgs/v1/:org_id/rooms/:room_key/messages?wait=<1..25>", cli: "messages:wait", openclaw: "messages:wait" },
  { id: "ack_room_message",             endpoint: "POST /orgs/v1/:org_id/rooms/:room_key/messages/:message_id/ack", cli: "messages:ack", openclaw: "messages:ack" },
  { id: "get_room_message",             endpoint: "GET /orgs/v1/:org_id/rooms/:room_key/messages/:message_id", cli: "messages:get", openclaw: "messages:get" },
  { id: "raise_escalation",             endpoint: "POST /orgs/v1/:org_id/escalations", cli: "escalations:raise", openclaw: "escalations:raise" },
  { id: "get_escalation",               endpoint: "GET /orgs/v1/:org_id/escalations/:escalation_id", cli: "escalations:get", openclaw: "escalations:get" },
  // The agent's loop is "poll MY escalation".
  { id: "list_escalations",             endpoint: "GET /orgs/v1/:org_id/escalations", cli: "escalations:list", openclaw: "escalations:list" },
  { id: "ack_escalation",               endpoint: "POST /orgs/v1/:org_id/escalations/:escalation_id/ack", cli: "escalations:ack", openclaw: "escalations:ack" },
  { id: "resolve_escalation",           endpoint: "POST /orgs/v1/:org_id/escalations/:escalation_id/resolve", cli: "escalations:resolve", openclaw: "escalations:resolve" },
  // Owner-only contact management (who gets paged): an agent raises, it does
  // not decide which humans exist to be paged — that is an owner action gated
  // behind a passkey step-up.
  { id: "manage_escalation_contacts",   endpoint: "GET /orgs/v1/:org_id/escalation-contacts", cli: "contacts:add", openclaw: "contacts:add" },
  { id: "claim_room_resource",          endpoint: "POST /orgs/v1/:org_id/rooms/:room_key/claims",  cli: "claims:create", openclaw: "claims:create" },
  { id: "list_room_claims",             endpoint: "GET /orgs/v1/:org_id/rooms/:room_key/claims", cli: "claims:list", openclaw: "claims:list" },
  { id: "release_room_claim",           endpoint: "DELETE /orgs/v1/:org_id/rooms/:room_key/claims/:claim_id", cli: "claims:release", openclaw: "claims:release" },

  // add-room-invite: a copy-paste door into an org and a room with no vault
  // and no human — mint a single-use `kri1_…` bearer key from the room the
  // inviter stands in; joining through one is `join_room`'s own row above
  // (the claim route rides its endpoint parenthetically, and `rooms.join`
  // is in SDK_ONLY_METHODS — one CLI verb, no second SURFACE row, no
  // duplicate `cli` string). Minting and redeeming the key refuse on the
  // sandbox surface (SECRET_REQUIRES_CLI): a bearer secret is minted.
  { id: "rooms_invite",                 endpoint: "POST /orgs/v1/:org_id/rooms/:room_key/invites", cli: "rooms:invite", openclaw: "rooms:invite" },

  // ── Release error rollup (release-error-rollup) ─────────────────────────
  // `run402 errors list` (list + verdict, and the promote-gate `--watch`) and
  // `run402 errors get <fingerprint_id>` (one identity's detail). The SDK's
  // errors.watch is tracked in SDK_ONLY_METHODS (it rides `errors list --watch`).
  { id: "errors_list",                  endpoint: "GET /projects/v1/:project_id/errors",           cli: "errors:list",                   openclaw: "errors:list" },
  { id: "errors_get",                   endpoint: "GET /projects/v1/:project_id/errors/:fingerprint_id", cli: "errors:get",                    openclaw: "errors:get" },

  // ── Sign-in session and write approval (a person, not the agent) ─────────
  // One sign-in session graded by provenance (loopback | device). A browser
  // ceremony (an MCP host holds no browser, and a person's session must not
  // become the agent's ambient authority).
  { id: "login",             endpoint: "POST /agent/v1/control-plane/cli/token (+ /cli/device, /cli/device/token)", cli: "login", openclaw: "login" },
  { id: "logout",            endpoint: "POST /agent/v1/control-plane/session/revoke",              cli: "logout",    openclaw: "logout" },
  { id: "adopt_org",         endpoint: "POST /orgs/v1/adopt (+ /challenge)",                        cli: "orgs:adopt", openclaw: "orgs:adopt" },
  { id: "approve",           endpoint: "POST /agent/v1/control-plane/write-approval/challenges (+ /cli/token)", cli: "approve", openclaw: "approve" },

  // ── Additional billing ─────────────────────────────────────────────────
  { id: "create_checkout",   endpoint: "POST /orgs/v1/:org_id/checkouts",        cli: "billing:checkout",  openclaw: "billing:checkout" },
  { id: "create_lightning_topup", endpoint: "POST /orgs/v1/:org_id/checkouts (rail: lightning)", cli: "billing:topup", openclaw: "billing:topup" },
  { id: "get_topup",         endpoint: "GET /orgs/v1/:org_id/checkouts/:topup_id", cli: null,                openclaw: null },
  { id: "billing_history",   endpoint: "GET /orgs/v1/:org_id/billing/history", cli: null, openclaw: null },

  // ── Version management ─────────────────────────────────────────────────
  { id: "update_version",    endpoint: "PATCH /projects/v1/admin/:id/versions/:version_id", cli: "apps:update", openclaw: "apps:update" },
  { id: "delete_version",    endpoint: "DELETE /projects/v1/admin/:id/versions/:version_id", cli: "apps:delete", openclaw: "apps:delete" },
  { id: "get_app",           endpoint: "GET /apps/v1/:version_id",          cli: "apps:inspect",     openclaw: "apps:inspect" },

  // ── Admin ──────────────────────────────────────────────────────────────
  // v1.57: pin/unpin endpoints removed. Per-project pin is superseded by the
  // organization-level escape hatch (admin_set_lease_perpetual). archive and
  // reactivate are staff moderation actions, scoped to a single project.
  { id: "admin_set_lease_perpetual", endpoint: "POST /orgs/v1/admin/:org_id/lease-perpetual", cli: "admin:lease-perpetual", openclaw: "admin:lease-perpetual" },
  { id: "admin_archive_project",     endpoint: "POST /projects/v1/admin/:id/archive",                 cli: "admin:archive",          openclaw: "admin:archive" },
  { id: "admin_reactivate_project",  endpoint: "POST /projects/v1/admin/:id/reactivate",              cli: "admin:reactivate",       openclaw: "admin:reactivate" },
  { id: "promote_user",    endpoint: "POST /projects/v1/admin/:id/promote-user", cli: "projects:promote-user", openclaw: "projects:promote-user" },
  { id: "demote_user",     endpoint: "POST /projects/v1/admin/:id/demote-user",  cli: "projects:demote-user",  openclaw: "projects:demote-user" },
  { id: "admin_project_finance", endpoint: "GET /admin/api/finance/project/:id", cli: "projects:costs", openclaw: "projects:costs" },

  // ── Project transfer (unified noun) — wallet + email (one accept) + owned-org (immediate) ──
  { id: "initiate_project_transfer", endpoint: "POST /projects/v1/:project_id/transfers",       cli: "transfer:init",    openclaw: "transfer:init" },
  { id: "preview_project_transfer",  endpoint: "GET /agent/v1/transfers/:transfer_id",          cli: "transfer:preview", openclaw: "transfer:preview" },
  { id: "accept_project_transfer",   endpoint: "POST /agent/v1/transfers/:transfer_id/accept",  cli: "transfer:accept",  openclaw: "transfer:accept" },
  { id: "cancel_project_transfer",   endpoint: "POST /agent/v1/transfers/:transfer_id/cancel",  cli: "transfer:cancel",  openclaw: "transfer:cancel" },
  { id: "list_incoming_transfers",   endpoint: "GET /agent/v1/transfers/incoming",              cli: "transfer:list",    openclaw: "transfer:list" },
  { id: "list_outgoing_transfers",   endpoint: "GET /agent/v1/transfers/outgoing",              cli: null,               openclaw: null },

  // ── Org-owned control plane: identity, membership, grants (v1.77+) ──────
  { id: "create_org",          endpoint: "POST /orgs/v1",                                 cli: "orgs:create",        openclaw: "orgs:create" },
  { id: "get_org",             endpoint: "GET /orgs/v1/:org_id",                          cli: "orgs:get",           openclaw: "orgs:get" },
  { id: "rename_org",          endpoint: "PATCH /orgs/v1/:org_id",                        cli: "orgs:rename",        openclaw: "orgs:rename" },
  { id: "set_org_payout_wallet", endpoint: "PATCH /orgs/v1/:org_id/payout-wallet",         cli: "orgs:payout-wallet", openclaw: "orgs:payout-wallet" },
  // repo-first-onramp task 4 (design D6): the slug CLAIM spends money and is
  // a permanent handle: a paid, side-effecting, hard-to-undo mutation belongs
  // to a command the caller typed.
  { id: "org_slug",            endpoint: "POST /orgs/v1/:org_id/slug",                    cli: "orgs:slug",          openclaw: "orgs:slug" },
  { id: "whoami",              endpoint: "GET /agent/v1/whoami (+ PATCH /agent/v1/me)", cli: "whoami",            openclaw: "whoami" },
  { id: "list_orgs",           endpoint: "GET /orgs/v1 (+ GET /agent/v1/me/overview)",    cli: "orgs:list",          openclaw: "orgs:list" },
  { id: "list_org_members",    endpoint: "GET /orgs/v1/:org_id/members",                      cli: "orgs:members:list",   openclaw: "orgs:members:list" },
  { id: "add_org_member",      endpoint: "POST /orgs/v1/:org_id/members",                     cli: "orgs:members:add",    openclaw: "orgs:members:add" },
  { id: "set_org_member_role", endpoint: "PATCH /orgs/v1/:org_id/members/:principal_id",      cli: "orgs:members:role",   openclaw: "orgs:members:role" },
  { id: "remove_org_member",   endpoint: "DELETE /orgs/v1/:org_id/members/:principal_id",     cli: "orgs:members:rm",     openclaw: "orgs:members:rm" },
  // vault-agent-envelopes D3: the owner's independent-credential rotation path (owner + step-up mutation).
  { id: "revoke_org_member_encryption_key", endpoint: "DELETE /orgs/v1/:org_id/members/:principal_id/encryption-key", cli: "orgs:members:revoke-key", openclaw: "orgs:members:revoke-key" },
  { id: "org_audit",           endpoint: "GET /orgs/v1/:org_id/audit",                        cli: "orgs:audit",         openclaw: "orgs:audit" },
  // Current-org selection (add-cli-current-org): LOCAL state, like wallets:use
  // and the local half of projects:use. No endpoint — the org id is resolved
  // client-side and only travels as a path segment on the calls that use it.
  { id: "org_use",             endpoint: "(local)",                                           cli: "orgs:use",           openclaw: "orgs:use" },
  { id: "org_current",         endpoint: "(local)",                                           cli: "orgs:current",       openclaw: "orgs:current" },
  { id: "org_clear",           endpoint: "(local)",                                           cli: "orgs:clear",         openclaw: "orgs:clear" },
  { id: "org_bind",            endpoint: "(local)",                                           cli: "orgs:bind",          openclaw: "orgs:bind" },
  { id: "org_unbind",          endpoint: "(local)",                                           cli: "orgs:unbind",        openclaw: "orgs:unbind" },
  { id: "org_invite_list",     endpoint: "GET /orgs/v1/:org_id/invites",                      cli: "orgs:invite:list",   openclaw: "orgs:invite:list" },
  { id: "org_invite_create",   endpoint: "POST /orgs/v1/:org_id/invites",                     cli: "orgs:invite:create", openclaw: "orgs:invite:create" },
  { id: "org_invite_rm",       endpoint: "DELETE /orgs/v1/:org_id/invites/:principal_id",     cli: "orgs:invite:rm",     openclaw: "orgs:invite:rm" },
  { id: "create_project_grant", endpoint: "POST /projects/v1/:id/grants",                 cli: "grants:create",     openclaw: "grants:create" },
  { id: "list_project_grants",  endpoint: "GET /projects/v1/:id/grants",                  cli: "grants:list",       openclaw: "grants:list" },
  { id: "revoke_project_grant", endpoint: "DELETE /projects/v1/:id/grants/:grant_id",     cli: "grants:revoke",     openclaw: "grants:revoke" },
  { id: "revoke_project_grant_key", endpoint: "DELETE /projects/v1/:id/grant-keys/:key_id", cli: "grants:revoke-key", openclaw: "grants:revoke-key" },
  // Rotating a grant key returns its token once: it refuses on the sandbox
  // surface (SECRET_REQUIRES_CLI), same as the project credentials below.
  { id: "rotate_project_grant_key", endpoint: "POST /projects/v1/:id/grant-keys/:key_id/rotate", cli: "grants:rotate-key", openclaw: "grants:rotate-key" },
  // Project credentials. issue/rotate/token return a one-time secret and
  // refuse on the sandbox surface (SECRET_REQUIRES_CLI): an MCP result lands
  // in an agent transcript, exactly where agent-response-design.md says
  // credential-create / credential-rotate / token-mint must never be persisted.
  { id: "issue_project_credential",  endpoint: "POST /projects/v1/:id/credentials",                     cli: "credentials:issue",  openclaw: "credentials:issue" },
  { id: "list_project_credentials",  endpoint: "GET /projects/v1/:id/credentials",                      cli: "credentials:list",   openclaw: "credentials:list" },
  { id: "project_credential_status", endpoint: "GET /projects/v1/:id/credential-status",                cli: "credentials:status", openclaw: "credentials:status" },
  { id: "rotate_project_credential", endpoint: "POST /projects/v1/:id/credentials/:credential_id/rotate", cli: "credentials:rotate", openclaw: "credentials:rotate" },
  { id: "revoke_project_credential", endpoint: "DELETE /projects/v1/:id/credentials/:credential_id",    cli: "credentials:revoke", openclaw: "credentials:revoke" },
  { id: "mint_project_token",        endpoint: "POST /projects/v1/:id/tokens",                          cli: "credentials:token",  openclaw: "credentials:token" },

  // ── Auth (project user) ────────────────────────────────────────────────
  { id: "request_magic_link", endpoint: "POST /auth/v1/magic-link",           cli: "auth:magic-link",    openclaw: "auth:magic-link" },
  { id: "verify_magic_link",  endpoint: "POST /auth/v1/token?grant_type=magic_link|email_code", cli: "auth:verify", openclaw: "auth:verify" },
  { id: "create_auth_user",   endpoint: "POST /auth/v1/admin/users",          cli: "auth:create-user",  openclaw: "auth:create-user" },
  { id: "invite_auth_user",   endpoint: "POST /auth/v1/admin/users",          cli: "auth:invite-user",  openclaw: "auth:invite-user" },
  { id: "set_user_password",  endpoint: "PUT /auth/v1/user/password",         cli: "auth:set-password",  openclaw: "auth:set-password" },
  { id: "auth_settings",      endpoint: "PATCH /auth/v1/settings",            cli: "auth:settings",      openclaw: "auth:settings" },
  { id: "passkey_register_options", endpoint: "POST /auth/v1/passkeys/register/options", cli: "auth:passkey-register-options", openclaw: "auth:passkey-register-options" },
  { id: "passkey_register_verify",  endpoint: "POST /auth/v1/passkeys/register/verify",  cli: "auth:passkey-register-verify",  openclaw: "auth:passkey-register-verify" },
  { id: "passkey_login_options",    endpoint: "POST /auth/v1/passkeys/login/options",    cli: "auth:passkey-login-options",    openclaw: "auth:passkey-login-options" },
  { id: "passkey_login_verify",     endpoint: "POST /auth/v1/passkeys/login/verify",     cli: "auth:passkey-login-verify",     openclaw: "auth:passkey-login-verify" },
  { id: "list_passkeys",            endpoint: "GET /auth/v1/passkeys",                   cli: "auth:passkeys",                 openclaw: "auth:passkeys" },
  { id: "delete_passkey",           endpoint: "DELETE /auth/v1/passkeys/:id",             cli: "auth:delete-passkey",           openclaw: "auth:delete-passkey" },
  { id: "auth_providers",    endpoint: "GET /auth/v1/providers",              cli: "auth:providers",     openclaw: "auth:providers" },
  { id: "auth_scaffold_roles", endpoint: "(local)",                           cli: "auth:scaffold-roles", openclaw: "auth:scaffold-roles" },

  // ── Email organizations + org checkout ─────────────────────────────
  { id: "create_email_organization", endpoint: "POST /orgs/v1/email",                   cli: "billing:create-email",   openclaw: "billing:create-email" },
  { id: "link_wallet_to_organization",       endpoint: "POST /orgs/v1/:org_id/wallets",   cli: "billing:link-wallet",    openclaw: "billing:link-wallet" },
  { id: "set_auto_recharge",            endpoint: "PATCH /orgs/v1/:org_id/billing/auto-recharge",  cli: "billing:auto-recharge",  openclaw: "billing:auto-recharge" },
  { id: "billing_balance",              endpoint: "GET /orgs/v1/:org_id/billing",        cli: "billing:balance",        openclaw: "billing:balance" },
  { id: "billing_history_cli",          endpoint: "GET /orgs/v1/:org_id/billing/history",        cli: "billing:history",        openclaw: "billing:history" },

  // ── Tier management ────────────────────────────────────────────────────
  { id: "tier_status",       endpoint: "GET /tiers/v1/status",             cli: "tier:status",      openclaw: "tier:status" },

  // ── Local wallet ───────────────────────────────────────────────────────
  // The Lightning wallet (mpp-lightning-over-nwc): one verb on every
  // surface; `init lightning` is the same mint through the existing `init`.
  { id: "lightning_wallet",  endpoint: "/agent/v1/lightning-wallet",       cli: "wallets:lightning", openclaw: "wallets:lightning" },
  { id: "wallet_create",  endpoint: "(local)",                          cli: null, openclaw: null },
  { id: "wallet_export",  endpoint: "(local)",                          cli: null, openclaw: null },

  // ── Service status (public, unauthenticated) ───────────────────────────
  { id: "service_status",    endpoint: "GET /status",                      cli: "service:status",   openclaw: "service:status" },
  { id: "service_health",    endpoint: "GET /health",                      cli: "service:health",   openclaw: "service:health" },

  // ── KMS signers ─────────────────────────────────────────────────────────
  { id: "provision_signer",          endpoint: "POST /contracts/v1/signers",                       cli: "contracts:provision-signer", openclaw: "contracts:provision-signer" },
  { id: "get_signer",                endpoint: "GET /contracts/v1/signers/:id",                    cli: "contracts:get-signer",       openclaw: "contracts:get-signer" },
  { id: "list_signers",              endpoint: "GET /contracts/v1/signers",                        cli: "contracts:list-signers",     openclaw: "contracts:list-signers" },
  { id: "set_recovery_address",      endpoint: "POST /contracts/v1/signers/:id/recovery-address",  cli: "contracts:set-recovery",     openclaw: "contracts:set-recovery" },
  { id: "set_low_balance_alert",     endpoint: "POST /contracts/v1/signers/:id/alert",             cli: "contracts:set-alert",        openclaw: "contracts:set-alert" },
  { id: "contract_call",             endpoint: "POST /contracts/v1/call",                          cli: "contracts:call",             openclaw: "contracts:call" },
  { id: "contract_deploy",           endpoint: "POST /contracts/v1/deploy",                        cli: "contracts:deploy",           openclaw: "contracts:deploy" },
  { id: "contract_read",             endpoint: "POST /contracts/v1/read",                          cli: "contracts:read",             openclaw: "contracts:read" },
  { id: "get_contract_call_status",  endpoint: "GET /contracts/v1/calls/:id",                      cli: "contracts:status",           openclaw: "contracts:status" },
  { id: "drain_signer",              endpoint: "POST /contracts/v1/signers/:id/drain",             cli: "contracts:drain",            openclaw: "contracts:drain" },
  { id: "delete_signer",             endpoint: "DELETE /contracts/v1/signers/:id",                 cli: "contracts:delete",           openclaw: "contracts:delete" },

  // ── repos (r402s/v0) — the host-blind encrypted git repo family ─────────
  // repo-surface-consolidation: the 19-command `vault`/`repos` sprawl
  // collapsed to ONE noun, 12 verbs. `vault` itself retired from the CLI
  // (design D7); old spellings are gone, not redirected.
  //
  // The reads carry no key material. The writes that mint key material or a
  // one-shot receipt (`create`'s recovery receipt, `handoff`/`invite` keys)
  // refuse on the sandbox surface (SECRET_REQUIRES_CLI); `gc` holds a
  // maintenance lease whose holder_token is returned exactly once and whose
  // submit half is destructive by contract; `policy` needs owner + step-up;
  // `mirror` writes local config or moves real bytes into a customer-owned
  // bucket; `delete`/`rename` are irreversible or identity-changing.
  { id: "repos_create", endpoint: "POST /projects/v1 (+ vault genesis admission)", cli: "repos:create", openclaw: "repos:create" },
  // Bulk vaults-by-org read (task 2.4) with a graceful per-project fallback
  // when the gateway hasn't shipped the route yet (`err.status === 404` in
  // `cli/lib/repos.mjs`'s `list()`) — see `Repos.listByOrg`'s doc comment
  // for the FROZEN response shape this codes against.
  { id: "repos_list",   endpoint: "GET /vaults/v1?org_id=<uuid> (404-graceful fallback: GET /projects/v1 + per-project GET /vaults/v1/:vault_id)", cli: "repos:list", openclaw: "repos:list" },
  // Design D3: side-effect-free by construction — never passes `refs: true`,
  // so it never materializes or advances a local pin. That belongs to `fsck`.
  { id: "repos_view",   endpoint: "GET /vaults/v1/:vault_id", cli: "repos:view", openclaw: "repos:view" },
  { id: "repos_list_heads", endpoint: "GET /vaults/v1/:vault_id/heads", cli: null, openclaw: null },
  // Absorbs the old `repos name` (repo-first-onramp D6) — same claim/rename
  // endpoint, `--repo`/`--project` addressing (`gh repo rename`, design D2).
  { id: "repos_rename", endpoint: "POST /projects/v1/:id/repo-name", cli: "repos:rename", openclaw: "repos:rename" },
  // Design D9: refuses PROJECT_HAS_NON_REPO_RESOURCES when the project holds
  // materialized database/functions/secrets/subdomains/mailbox — reads each
  // via the SAME service-key credential `projects.delete` itself requires.
  { id: "repos_delete", endpoint: "DELETE /projects/v1/:id (+ reads: GET /projects/v1/:id, /admin/:id/schema, /admin/:id/functions, secrets, subdomains)", cli: "repos:delete", openclaw: "repos:delete" },
  { id: "repos_capture", endpoint: "POST /vaults/v1/:vault_id/upload-sessions (+ admission)", cli: "repos:capture", openclaw: "repos:capture" },
  // kygit-handoff design D7/D10: a bearer secret is minted (`handoff`) and
  // membership + a working tree are mutated (`resume`) — the same law that
  // makes `repos handoff/resume` refuse on the sandbox surface
  // (SECRET_REQUIRES_CLI).
  { id: "repos_handoff", endpoint: "POST /vaults/v1/:vault_id/handoffs", cli: "repos:handoff", openclaw: "repos:handoff" },
  { id: "repos_resume", endpoint: "POST /vaults/v1/handoffs/:handoff_id/redeem", cli: "repos:resume", openclaw: "repos:resume" },
  // kygit-invite design D1/D9: the second claim kind, same law as
  // handoff/resume above — a bearer secret is minted (`invite`) and
  // membership + a working tree are mutated (`join`), so both refuse on the
  // sandbox surface (SECRET_REQUIRES_CLI).
  { id: "repos_invite", endpoint: "POST /vaults/v1/:vault_id/invites", cli: "repos:invite", openclaw: "repos:invite" },
  { id: "repos_join", endpoint: "POST /vaults/v1/invites/:invite_id/redeem", cli: "repos:join", openclaw: "repos:join" },
  // The gateway's own VAULT_CLIENT_UPGRADE_REQUIRED envelope names
  // `run402 repos policy grandfathered --reason <why>` as a next_action, so
  // the verb has to exist: without it a user can allocate themselves into a
  // blocked-deploy state and the platform's documented way out is a command
  // that returns UNKNOWN_SUBCOMMAND.
  { id: "repos_policy", endpoint: "PATCH /vaults/v1/:vault_id/policy", cli: "repos:policy", openclaw: "repos:policy" },
  // Design D4: ONE flag-driven verb replaces the old five-verb `mirror
  // set/remove/status/sync/verify` subtree — no-arg reads, `<destination>`
  // upserts, `--off` removes config only, `--backfill` catches up.
  { id: "repos_mirror", endpoint: "GET /vaults/v1/:vault_id/objects", cli: "repos:mirror", openclaw: "repos:mirror" },
  // Design D2/D3: absorbs `verify` (chain walk + pin advance) AND
  // `status --refs`'s materialization (`--refs` itself is removed — that
  // side effect belongs here, not in `view`). `--mirror` absorbs
  // `mirror verify`'s keyless probe. `--no-write` is a genuine audit mode
  // (`Repos.fsck({write:false})` computes the same real answer without
  // persisting either local pin).
  { id: "repos_fsck",   endpoint: "GET /vaults/v1/:vault_id/heads[/:generation]", cli: "repos:fsck", openclaw: "repos:fsck" },
  // Design D2: `git gc`'s own two halves — checkpoint publication (compact)
  // and prune planning — in one verb, explicitly NOT described as "exactly
  // git gc" (the deletion ceremony is stricter). Plans by default; submits
  // only with both two-phase-protocol receipts (§7.3) — there is still no
  // purge verb.
  { id: "repos_gc",     endpoint: "POST /vaults/v1/:vault_id/maintenance-leases + POST .../prune-intents", cli: "repos:gc", openclaw: "repos:gc" },
  // vault-persistent-helper: the resident engine's inspect/retire verb —
  // a bounded LOCAL socket probe, no gateway endpoint (the daemon accelerates
  // the git remote helper).
  { id: "repos_daemon", endpoint: "(local)", cli: "repos:daemon", openclaw: "repos:daemon" },
  // Design D5/D7/D10: READ-ONLY successor to the removed `reconcile`
  // workaround (its own help text called itself a workaround — a newly-
  // wrapped member got the vault's ENTIRE history under one fixed epoch,
  // never real epoch rotation). Composes the org encryption-key directory +
  // the vault's covered envelope-recipient fingerprints + (best-effort,
  // Node-only) this machine's local TOFU pins — never wraps a key.
  // `access repair`/`revoke-key`/`declare-exposure` (D193-D203, rev 42 —
  // real epoch rotation, closing the gap this row's own `gap` field named)
  // share this SAME `repos:access` CLI dispatch, like `errors.watch`
  // shares `errors list` — see SDK_ONLY_METHODS below for their
  // SDK methods.
  { id: "repos_access", endpoint: "GET /orgs/v1/:org_id/encryption-keys + GET /vaults/v1/:vault_id/envelope-recipients (+ GET /agent/v1/source-access/wrappers for the caller's own member_custody block, control-plane session only)", cli: "repos:access", openclaw: "repos:access" },
  // `r402s-recover`: offline, NO server call at all (design D4), the same
  // "(local)" shape as `expand_result` below. Name UNCHANGED per D10 —
  // `restore` collides with `git restore`'s different meaning (D2 rule 4).
  { id: "repos_recover", endpoint: "(local)", cli: "repos:recover", openclaw: "repos:recover" },

  // ── recovery-bundle (vault-recovery-custody) — member key custody, read side ──
  // Enrollment/activation/revocation are BROWSER ceremonies (WebAuthn at
  // console.run402.com/account) so they have no CLI or SDK spelling at all;
  // what the CLI carries is the export that makes the source recovery code
  // work offline — the artifact `repos recover --bundle` consumes, so it
  // lives in the repos family (a gateway route namespace is not a CLI noun). The wrapper-states read has no verb of
  // its own — it rides `repos access` as its member_custody block. CLI-only
  // — the bundle is half of a recovery credential; same
  // "mutating-verbs-are-CLI-only"-adjacent caution the repos family applies.
  { id: "repos_recovery_bundle", endpoint: "GET /agent/v1/source-access/recovery-bundle", cli: "repos:recovery-bundle", openclaw: "repos:recovery-bundle" },

];

// ─── SDK namespace mapping ──────────────────────────────────────────────────
// Each SURFACE capability should map to
// an SDK method path `"namespace.method"`. Capabilities that are intentionally
// not on the SDK map to null.
//
// When you add a new capability to SURFACE that ships an SDK method, also
// add the id → path mapping here. The tests below enforce both sides.

const SDK_BY_CAPABILITY: Record<string, string | null> = {
  // Local-only compound flows.
  up: "actions.up",
  // Local state (code-mode MCP section 2): the Node SDK's root methods.
  init: "init",
  pay_url: "pay.fetch",
  status: "status",
  identity_links: "identityLinks.nostr.begin",
  buzz_status: "buzz.status",
  buzz_adopt: "buzz.offerAdoption",
  buzz_install: "buzz.install",
  buzz_enroll: "buzz.enrollments.request",
  buzz_join: "buzz.communityInstallations.joinAsTeammate",
  buzz_approve: "buzz.enrollments.approve",
  buzz_deny: "buzz.enrollments.deny",
  buzz_revoke: "buzz.enrollments.revoke",
  buzz_notify_configure: "buzz.notifications.createRoute",
  buzz_notify_list: "buzz.notifications.list",
  buzz_notify_get: "buzz.notifications.get",
  buzz_notify_test: "buzz.notifications.test",
  buzz_notify_deliveries: "buzz.notifications.deliveries",
  buzz_notify_pause: "buzz.notifications.pause",
  buzz_notify_resume: "buzz.notifications.resume",
  buzz_notify_rotate: "buzz.notifications.rotate",
  buzz_notify_revoke: "buzz.notifications.revoke",
  buzz_notify_on_call: "buzz.notifications.update",
  buzz_notify_projects: "buzz.notifications.update",
  buzz_notify_scope: "buzz.notifications.update",

  // repos (host-blind git repos) — all protocol logic is SDK-side; the CLI
  // is an adapter (task 5.0). `repos` is porcelain over projects.provision +
  // repos.init + projects.delete + repos.status for the compound
  // verbs — no single SDK method of its own, the same compound-flow shape
  // `up`/`init` already established.
  // `create` composes projects.provision + repos.init; repos.init is
  // the defining allocation call (the same mapping `vault_init` used
  // before the rename), so it is the primary reference here rather than a
  // compound-flow null.
  repos_create: "repos.init",
  repos_list_heads: "repos.heads",
  // Bulk vaults-by-org read is the PRIMARY method now (task 2.4); the
  // per-project fallback loop composes repos.status internally and needs
  // no mapping of its own, the same way every other N+1 fallback in this
  // file does not get one.
  repos_list: "repos.listByOrg",
  repos_view: "repos.status",
  repos_rename: "projects.setRepoName",
  repos_delete: null,
  repos_capture: "repos.capture",
  // kygit-handoff design D7: protocol logic lives once in the SDK's
  // `Repos.handoff`/`Repos.resume` — the CLI's `repos handoff`/
  // `repos resume` are thin adapters over them.
  repos_handoff: "repos.handoff",
  repos_resume: "repos.resume",
  // kygit-invite design D9: the same law, the second claim kind — protocol
  // logic lives once in the SDK's `Repos.invite`/`Repos.join`.
  repos_invite: "repos.invite",
  repos_join: "repos.join",
  repos_policy: "repos.setPolicy",
  // `mirror` is a compound CLI verb (no-arg read / <dest> upsert / --off /
  // --backfill) that dispatches to four distinct SDK methods internally —
  // same compound-flow shape as `up`/`init` above; see SDK_ONLY_METHODS for
  // the individual mappings.
  repos_mirror: null,
  repos_fsck: "repos.fsck",
  // `gc` composes checkpoint publication (compact) and prune planning/submit
  // — same compound-flow shape as `mirror` above; see SDK_ONLY_METHODS.
  repos_gc: null,
  repos_daemon: null, // local socket probe only (vault-persistent-helper) — no SDK capability
  repos_access: "repos.access",
  repos_recover: "repos.recover",
  repos_recovery_bundle: "session.sourceAccessRecoveryBundle",

  // Named wallets and the organization context — local state owned by
  // `@run402/sdk/node` (NodeWallets, NodeOrgs).
  wallets_list: "wallets.list",
  wallets_current: "wallets.current",
  wallets_new: "wallets.create",
  wallets_use: "wallets.use",
  org_use: "orgs.use",
  org_current: "orgs.current",
  org_clear: "orgs.clear",
  org_bind: "orgs.bind",
  org_unbind: "orgs.unbind",
  wallets_rename: "wallets.rename",
  wallets_bind: "wallets.bind",
  wallets_unbind: "wallets.unbind",
  wallets_import: "wallets.import",
  wallets_rm: "wallets.remove",

  // `run402 doctor` is the Node SDK's root `doctor()`; `--buzz` rides it
  // (buzz.doctor is in SDK_ONLY_METHODS).
  doctor: "doctor",
  // SSR Runtime DX (v1.52) — local/CLI-only; no SDK
  dev: null,
  // `run402 logs` is the project-wide request-id search; the SDK owns the
  // cross-function fan-out (no gateway route exists for it).
  logs: "functions.logsByRequestId",

  // SSR origin cache (v1.52)
  cache_invalidate: "cache.invalidate",
  cache_inspect: "cache.inspect",

  // Project lifecycle
  get_quote: "projects.getQuote",
  provision: "projects.provision",
  tier_set: "tier.set",
  delete: "projects.delete",
  export_project_archive: "archives.export",
  download_project_archive: "archives.download",
  get_project_archive: "archives.get",
  inspect_project_archive: "archives.inspect",
  verify_project_archive: "archives.verify",
  import_project_archive: "archives.importToCore",
  create_project_snapshot: "snapshots.create",
  list_project_snapshots: "snapshots.list",
  get_project_snapshot: "snapshots.get",
  restore_project_snapshot: "snapshots.restore",
  delete_project_snapshot: "snapshots.delete",
  create_project_branch: "branches.create",
  list_project_branches: "branches.list",
  renew_project_branch: "branches.renew",
  delete_project_branch: "branches.delete",
  faucet: "wallets.faucet",

  // Database / Admin
  run_sql: "projects.sql",
  run_sql_batch: "projects.sqlBatch",
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
  deploy_site: null, // the CLI stages files to a temp dir and composes deployDir
  deploy_site_dir: "sites.deployDir", // Node-only SDK helper: walks fs + unified deploy primitive
  add_subdomain: "subdomains.add",
  delete_subdomain: "subdomains.delete",
  list_subdomains: "subdomains.list",

  // Project domains
  domains_connect: "domains.connect",
  domains_list: "domains.list",
  domains_get: "domains.get",
  domains_dns: "domains.get",
  domains_check: "domains.check",
  domains_apply: "domains.apply",
  domains_repair: "domains.repair",
  domains_test_receive: "domains.testReceive",
  domains_wait: "domains.wait",
  domains_activate: "domains.activate",
  domains_disconnect: "domains.disconnect",

  // Unified apply. The engine lives
  // at r._applyEngine internally; the public hero is r.project(id).apply.
  // SDK_BY_CAPABILITY targets the engine instance for resolution checks.
  deploy: "_applyEngine.apply",
  deploy_rehearse: "_applyEngine.rehearse",
  deploy_promote: "_applyEngine.promote",
  deploy_resume: "_applyEngine.resume",
  deploy_status: "_applyEngine.status",
  deploy_list: "_applyEngine.list",
  deploy_events: "_applyEngine.events",
  deploy_verify_edge: "_applyEngine.edgeCoherence",
  deploy_releases_get: "_applyEngine.getRelease",
  deploy_releases_active: "_applyEngine.getActiveRelease",
  deploy_releases_diff: "_applyEngine.diff",
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
  list_tenant_payments: "projects.listTenantPayments",
  rename_project: "projects.rename",
  project_get: "projects.get",
  project_info_local: "projects.info",
  project_use: "projects.use",
  project_keys_local: "projects.keys",
  project_current: "projects.active",
  project_key_cache_list: "credentials.projectKeys.list",
  project_key_cache_status: "credentials.projectKeys.status",
  project_key_cache_import: "credentials.projectKeys.import",
  project_key_cache_export: "credentials.projectKeys.export",
  project_key_cache_remove: "credentials.projectKeys.remove",
  create_checkout: "billing.createCheckout",
  create_lightning_topup: "billing.createLightningTopup",
  lightning_wallet: "agent.lightningWallet.mint",
  get_topup: "billing.getTopup",
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
  send_feedback: "admin.sendFeedback",
  set_agent_contact: "admin.setAgentContact",
  get_agent_contact_status: "admin.getAgentContactStatus",
  verify_agent_contact_email: "admin.verifyAgentContactEmail",

  // Owner notifications (v1.55)
  list_notifications: "admin.listNotifications",
  list_project_events: "events.list",
  // tenant-live-changes: the CLI verb streams via `live.subscribe`; the held
  // read `live.changes` is the polling-friendly shape and the mapped method.
  live_changes: "live.changes",
  join_room: "rooms.registerPresence",
  send_room_message: "rooms.sendMessage",
  read_room_messages: "rooms.listMessages",
  // kygit-invite design D7: the agent's ear, built on the shared `waitFor`
  // contract over the held read.
  messages_wait: "rooms.waitForMessages",
  ack_room_message: "rooms.ackMessage",
  leave_room: "rooms.leave",
  list_rooms: "rooms.list",
  get_room: "rooms.get",
  claim_room_resource: "rooms.createClaim",
  release_room_claim: "rooms.releaseClaim",
  get_room_message: "rooms.getMessage",
  list_room_claims: "rooms.listClaims",
  rooms_invite: "rooms.invite",
  raise_escalation: "escalations.raise",
  get_escalation: "escalations.get",
  list_escalations: "escalations.list",
  ack_escalation: "escalations.ack",
  resolve_escalation: "escalations.resolve",
  manage_escalation_contacts: "escalations.listContacts",
  errors_list: "errors.list",
  errors_get: "errors.get",
  get_notification: "admin.getNotification",
  get_notification_preferences: "admin.getNotificationPreferences",
  set_notification_preferences: "admin.setNotificationPreferences",
  test_notification: "admin.testNotification",
  rotate_webhook_secret: "admin.rotateWebhookSecret",
  start_contact_passkey_enrollment: "admin.startContactPasskeyEnrollment",

  // Telegram notification channel + routing rules
  // (notification-channel-routing-telegram) — sub-namespaces on admin, same
  // shape as admin.transfers.
  connect_telegram_channel: "admin.channels.connectTelegram",
  list_notification_channels: "admin.channels.list",
  revoke_telegram_channel: "admin.channels.revokeTelegram",
  list_notification_rules: "admin.rules.list",
  create_notification_rule: "admin.rules.create",
  delete_notification_rule: "admin.rules.delete",

  // Sign-in session. `login` maps to the loopback exchange; the authorize URL
  // and the device flow (`login --device`) share the verb and are listed in
  // SDK_ONLY_METHODS below.
  login: "session.exchangeCliToken",
  logout: "session.revoke",
  // Claim maps to the submit step; the challenge step is in SDK_ONLY_METHODS and
  // the full dance is the Node convenience `adoptOrg` (a standalone export).
  adopt_org: "orgs.adopt.submit",
  approve: "writeApproval.requestChallenge",

  // Admin (v1.57)
  admin_set_lease_perpetual: "admin._setLeasePerpetual",
  admin_archive_project: "admin.archiveProject",
  admin_reactivate_project: "admin.reactivateProject",
  promote_user: "auth.promote",
  demote_user: "auth.demote",
  admin_project_finance: "admin.getProjectFinance",

  // Project transfer (unified noun) — sub-namespace lives on admin.transfers
  initiate_project_transfer: "admin.transfers.initiate",
  preview_project_transfer: "admin.transfers.preview",
  accept_project_transfer: "admin.transfers.accept",
  cancel_project_transfer: "admin.transfers.cancel",
  list_incoming_transfers: "admin.transfers.listIncoming",
  list_outgoing_transfers: "admin.transfers.listOutgoing",

  // Org-owned control plane (v1.77+) — r.org.* + r.grants.*
  create_org: "orgs.create",
  get_org: "org.get",
  rename_org: "org.rename",
  set_org_payout_wallet: "org.setPayoutWallet",
  org_slug: "org.setSlug",
  whoami: "orgs.whoami",
  list_orgs: "orgs.list",
  list_org_members: "org.members.list",
  add_org_member: "org.members.add",
  set_org_member_role: "org.members.setRole",
  remove_org_member: "org.members.revoke",
  revoke_org_member_encryption_key: "org.members.revokeEncryptionKey",
  org_audit: "org.audit",
  org_invite_list: "org.invites.list",
  org_invite_create: "org.invites.create",
  org_invite_rm: "org.invites.revoke",
  create_project_grant: "grants.create",
  list_project_grants: "grants.list",
  revoke_project_grant: "grants.revoke",
  revoke_project_grant_key: "grants.revokeKey",
  rotate_project_grant_key: "grants.rotateKey",
  issue_project_credential: "credentials.issue",
  list_project_credentials: "credentials.list",
  project_credential_status: "credentials.status",
  rotate_project_credential: "credentials.rotate",
  revoke_project_credential: "credentials.revoke",
  mint_project_token: "credentials.mintToken",

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
  auth_scaffold_roles: null, // offline CLI generator — no SDK method

  // Vouchers
  redeem_voucher: "vouchers.redeem",

  // Tier
  tier_status: "tier.status",

  // Local wallet (managed via the Node provider)
  wallet_create: "wallets.create",
  wallet_export: "wallets.export",

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
    // Local state (code-mode MCP section 2): the Node entry's wallets, orgs,
    // and buzz namespaces extend the isomorphic ones; diagnostics is Node-only.
    { namespace: "wallets", modulePath: "./sdk/dist/node/wallets.js", exportName: "NodeWallets" },
    { namespace: "orgs", modulePath: "./sdk/dist/node/org-context.js", exportName: "NodeOrgs" },
    { namespace: "buzz", modulePath: "./sdk/dist/node/buzz-doctor.js", exportName: "NodeBuzz" },
    { namespace: "diagnostics", modulePath: "./sdk/dist/node/diagnostics.js", exportName: "Diagnostics" },
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

  // Root-level methods the Node entry adds to the client itself (`r.doctor()`,
  // `r.init()`, `r.status()`), listed by bare name.
  const nodeModule = (await import("./sdk/dist/node/index.js")) as { run402: (opts: unknown) => Record<string, unknown> };
  const nodeClient = nodeModule.run402({ apiBase: "https://invalid.example", credentials: stub, disablePaidFetch: true });
  for (const name of ["doctor", "init", "status"]) {
    if (typeof nodeClient[name] === "function" && !methods.includes(name)) methods.push(name);
  }

  return methods.sort();
}

// ─── Derived expected sets ───────────────────────────────────────────────────

/**
 * The MCP server's whole tool set (code-mode MCP, decision 18 of 2026-09-22).
 * `src/index.ts` registers exactly these; everything else is a `run` snippet
 * against the SDK. There is no profile and no per-capability MCP tool.
 */
const MCP_TOOLS = ["up", "deploy", "status", "whoami", "doctor", "docs", "run", "expand_result"] as const;

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
const CLI_DISPATCH_COMMANDS = ["email:webhooks", "deploy:releases"];

// CLI aliases that route to the same handler as a primary command already in
// SURFACE. Listed here so the "no untracked commands" check doesn't fail.
// Primary name is what appears in SURFACE; the alias is kept for backward compat.
const CLI_ALIAS_COMMANDS = [
  "email:status", // alias of email:info
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("MCP tool set", () => {
  it("src/index.ts registers exactly MCP_TOOLS", () => {
    assert.deepEqual(
      parseMcpTools(),
      [...MCP_TOOLS].sort(),
      "src/index.ts must register exactly the tools in MCP_TOOLS (sync.test.ts): up, deploy, status, whoami, doctor, docs, run, expand_result. " +
        "A capability is reached through `run`, never through a tool of its own.",
    );
  });

  it("every MCP tool declares an outputSchema", () => {
    const missing = parseMcpRegistrations().filter((r) => !r.outputSchema).map((r) => r.name);
    assert.deepEqual(
      missing,
      [],
      `Register these tools with server.registerTool and an outputSchema (src/structured.ts OUTPUT_SCHEMAS): ${missing.join(", ")}. ` +
        "Every tool returns structuredContent under a declared schema.",
    );
  });

  it("every MCP tool is documented in docs-site/src/content/docs/mcp/", () => {
    const mcpDocs = markdownFiles(join(__dirname, "docs-site/src/content/docs/mcp"))
      .map((f) => readFileSync(f, "utf-8"))
      .join("\n");
    const undocumented = MCP_TOOLS.filter((t) => !mcpDocs.includes(`\`${t}\``));
    assert.deepEqual(undocumented, [], `MCP tools with no line in docs-site/src/content/docs/mcp/: ${undocumented.join(", ")}`);
  });
});

/**
 * How a document names an MCP tool. Each pattern captures the name; every
 * captured name must be in MCP_TOOLS. The phrasings are the ones tool
 * references are written in: "the `x` tool", "MCP `x`", "tool `x`", a list
 * after "MCP tools …:", a call written `x({ … })`, `{ "tool": "x" }`, and in
 * markdown, a table whose first column is headed "Tool". On an MCP reference
 * page (docs-site/…/mcp/) a `### \`x\`` heading names a tool, and so does a
 * "- `x` — …" bullet under a heading that says "tool".
 */
const TOOL_REFERENCE_PATTERNS: RegExp[] = [
  /\bMCP(?:\s+tools?)?\s+`([a-z][a-z0-9_]*)`/g, // MCP `x`, MCP tool `x`
  /`([a-z][a-z0-9_]*)`\s+(?:MCP\s+)?tools?\b/g, // `x` tool, `x` MCP tool
  /\btools?\s+`([a-z][a-z0-9_]*)`/g, // tool `x`
  /"tool"\s*:\s*"([a-z][a-z0-9_]*)"/g, // { "tool": "x" }
];
/** `x({ … })`, excluding a method or a package factory (`r.x({`, `run402({`). */
const TOOL_CALL_PATTERN = /(?<![\w.$])`([a-z][a-z0-9_]*)\(\{/g;
const TOOL_LIST_PATTERN = /\bMCP tools?\b[^.:\n]*:((?:\s*,?\s*(?:and\s+|or\s+)?`[a-z][a-z0-9_]*`)+)/g;
const MCP_PAGE_HEADING = /^#{2,4} `([a-z][a-z0-9_]*)`/gm; // ### `x`
const NOT_A_TOOL_CALL = new Set(["run402"]);

export function toolReferences(text: string, opts: { mcpPage?: boolean } = {}): string[] {
  const names = new Set<string>();
  const patterns = opts.mcpPage ? [...TOOL_REFERENCE_PATTERNS, MCP_PAGE_HEADING] : TOOL_REFERENCE_PATTERNS;
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) names.add(m[1]!);
  }
  for (const m of text.matchAll(TOOL_CALL_PATTERN)) if (!NOT_A_TOOL_CALL.has(m[1]!)) names.add(m[1]!);
  for (const m of text.matchAll(TOOL_LIST_PATTERN)) {
    for (const n of m[1]!.matchAll(/`([a-z][a-z0-9_]*)`/g)) names.add(n[1]!);
  }
  // A markdown table whose first column is headed "Tool" lists tools; on an
  // MCP page, so does a "- `x` — …" bullet under a heading that says "tool".
  let toolTable = false;
  let toolSection = false;
  for (const line of text.split("\n")) {
    const heading = /^#{1,6} (.*)$/.exec(line);
    if (heading) toolSection = /\btools?\b/i.test(heading[1]!);
    const bullet = /^\s*[-*] `([a-z][a-z0-9_]*)` —/.exec(line);
    if (opts.mcpPage && toolSection && bullet) names.add(bullet[1]!);
    if (!line.trimStart().startsWith("|")) {
      toolTable = false;
      continue;
    }
    const first = line.split("|")[1]?.trim() ?? "";
    if (/^tools?$/i.test(first)) {
      toolTable = true;
      continue;
    }
    const cell = /^`([a-z][a-z0-9_]*)`$/.exec(first);
    if (toolTable && cell) names.add(cell[1]!);
  }
  return [...names];
}

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...markdownFiles(full));
    else if (/\.mdx?$/.test(e.name)) out.push(full);
  }
  return out.sort();
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (e.name.endsWith(".ts") && !e.name.includes(".test.")) out.push(full);
  }
  return out.sort();
}

describe("MCP doc drift", () => {
  it("recognizes a tool named in prose, in a list, in a table, and on an MCP page", () => {
    assert.deepEqual(toolReferences("Use the `assets_put` MCP tool to upload."), ["assets_put"]);
    assert.deepEqual(toolReferences("call MCP `tier_set` first"), ["tier_set"]);
    assert.deepEqual(toolReferences("then `docs({ topic: \"assets\" })`"), ["docs"]);
    assert.deepEqual(toolReferences("MCP tools mirror the same flow: `a_b`, `c_d`, and `e_f`."), ["a_b", "c_d", "e_f"]);
    assert.deepEqual(toolReferences("| Tool | Description |\n|---|---|\n| `run_sql` | SQL |\n"), ["run_sql"]);
    assert.deepEqual(toolReferences("### `get_usage`\n## Tools\n- `list_orgs` — lists", { mcpPage: true }), ["get_usage", "list_orgs"]);
    assert.deepEqual(toolReferences("## Credentials\n- `anon_key` — read-only", { mcpPage: true }), []);
    assert.deepEqual(toolReferences("`project_id` is a field; `r.projects.list({ limit })` and `run402({ surface })` are SDK"), []);
  });

  it("no public surface or tool description names an MCP tool outside MCP_TOOLS", () => {
    const surfaces = [
      join(__dirname, "README.md"),
      join(__dirname, "SKILL.md"),
      join(__dirname, "openclaw/SKILL.md"),
      ...markdownFiles(join(__dirname, "docs-site/src/content/docs")),
      ...sourceFiles(join(__dirname, "src")),
    ];
    const allowed = new Set<string>(MCP_TOOLS);
    const offenders: string[] = [];
    const mcpPages = join(__dirname, "docs-site/src/content/docs/mcp");
    for (const file of surfaces) {
      const text = readFileSync(file, "utf-8");
      for (const name of toolReferences(text, { mcpPage: file.startsWith(mcpPages) })) {
        if (!allowed.has(name)) offenders.push(`${file.slice(__dirname.length + 1)}: \`${name}\``);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "These surfaces name MCP tools that do not exist; the MCP server registers only MCP_TOOLS (sync.test.ts). " +
        "Name the SDK method a `run` snippet calls, or the CLI command, instead.",
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
    // SDK-internal helpers that don't have a corresponding CLI entry (MCP
    // reaches every SDK method through `run`, so it adds no entry of its own).
    // Private in TypeScript but enumerable at runtime (TS `private` isn't
    // runtime-enforced), plus convenience methods consumers can compose
    // without needing a verb of their own.
    const SDK_ONLY_METHODS = new Set([
      // The organization resolver every org-scoped verb consumes (through
      // cli/lib/org-context.mjs) and its helpers: `projects use` stamps the
      // project's org, the vault scaffold reads the owning org. No verb of
      // their own.
      "orgs.resolve",
      "orgs.selected",
      "orgs.selectFromProject",
      "orgs.owningOrgOf",
      // The local wallet read behind `wallets current` (wallets.current).
      "wallets.status",
      // `run402 doctor --buzz` rides the doctor capability; the preflight
      // measures origins with diagnostics.probeOrigin.
      "buzz.doctor",
      "diagnostics.probeOrigin",
      // Minting another key against an existing grant: `grants create --key`
      // mints the first key with the grant; a second key is an SDK call.
      "grants.createKey",
      // tenant-live-changes: the reconnecting SSE subscription rides beside the
      // mapped held read (`live.changes`); the CLI verb `live` streams through it.
      "live.subscribe",
      // lightning-cash-topup: the CLI's `--wait` loop.
      "billing.waitForTopup",
      // mpp-lightning-over-nwc: one verb (`lightning_wallet` / `wallets lightning`)
      // covers mint, read, and revoke; the SDK exposes them separately.
      "agent.lightningWallet.get",
      "agent.lightningWallet.revoke",
      "agent.lightningWallet.waitForActive",
      // principal-display-name (first-deploy-agent-dx): `PATCH /agent/v1/me`
      // rides the whoami door on every surface (`whoami --set-name`,
      // and `r.orgs.setDisplayName` from a `run` snippet), so it has no verb of its own.
      "orgs.setDisplayName",
      // Adopt challenge is the first step of the org adopt flow; the
      // `adopt_org` capability maps to the submit step, and the Node
      // convenience `adoptOrg` composes challenge + sign + submit.
      "orgs.adopt.challenge",
      // vault-recovery-custody: the wrapper-states read has no verb of
      // its own — `repos access` composes it into its member_custody block
      // (the capability row maps to repos.access, the primary read).
      "session.sourceAccessWrappers",
      // vault-compaction-headroom-preflight: the same arithmetic
      // `repos.compact` preflights on, with none of its policy. It has no
      // verb of its own — `repos gc` composes it into its `headroom` block on
      // the --submit half, where no compaction runs (the capability row maps
      // to repos.compact, which carries the block itself on the planning
      // half).
      "repos.compactHeadroom",
      // vault-checkpoint-cadence design D3: `compact()` opens/closes the
      // compaction headroom grant internally (before staging the checkpoint,
      // closed once it publishes) — these standalone entry points exist for
      // tests and a future staff/diagnostic surface, not as a verb of
      // their own; there is no CLI surface that opens or closes a grant
      // without also compacting.
      "repos.openCompactionGrant",
      "repos.closeCompactionGrant",
      // Deprecated alias of admin.sendFeedback, kept so code written against
      // the old name keeps COMPILING. It posts to the new /feedback/v1 path,
      // so it is not a second capability - it is the same one, spelled the
      // way it used to be. Delete it when the `message` vocabulary is reused.
      "admin.sendMessage",
      // add-room-invite: the key-form redemption `rooms join <kri1_…>` runs —
      // it has no capability row of its own, the same law as
      // `session.devicePoll` sharing the `login` verb above: `join_room`'s
      // own CLI spelling (`rooms:join`) already covers both forms, and a
      // second row here would collide on that one `cli` string.
      "rooms.join",
      // escalations: the capability rows above cover raise/get/list/ack/
      // resolve/contacts-list. These are the rest of the namespace.
      // addContact/removeContact ride the one `manage_escalation_contacts`
      // capability (one CLI group, owner-gated).
      "escalations.addContact",
      "escalations.removeContact",
      // ackWithToken is the hosted one-tap page's call, not an agent verb —
      // the token comes from an email/Telegram link a human taps.
      "escalations.ackWithToken",
      // raiseAndWait composes raise + poll for the common "I genuinely cannot
      // proceed" case; the CLI spells it `escalations raise --wait`.
      "escalations.raiseAndWait",
      "email.resolveMailbox",  // private helper
      "email.listMailboxEnvelope", // private helper
      "email.pickMailbox",     // private helper
      "email.pickDefaultOutboundMailbox", // private helper
      "email.cacheMailbox",    // private helper
      // billing.lookupOrganization resolves a wallet/email → org_id via
      // GET /orgs/v1/lookup?wallet=|?email=. It's an SDK primitive used by
      // getAccount/getHistory and exposed for consumers that only need the id;
      // no dedicated CLI verb (the wallet/email-keyed balance/history
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
      // the hero implementation (and by tests). The MCP `deploy` tool wraps
      // r._applyEngine.apply.
      "_applyEngine.start",
      "_applyEngine.plan",
      "_applyEngine.upload",
      "_applyEngine.commit",
      "_applyEngine.waitEdgeCoherent",
      // CI token exchange is intentionally credential-helper-only in v1.
      "ci.exchangeToken",
      // ─── Epoch rotation (D193-D203, rev 42) ─────────────────────────────
      // confirmRecipient/repinRecipient issue the D197 confirmation receipt
      // a pin-manifest publish cites — owner+step-up ceremonies with no
      // standalone CLI surface today (a future `repos access confirm`/
      // `repin` CLI verb is the natural home; out of this change's scope).
      "repos.confirmRecipient",
      "repos.repinRecipient",
      // The PUBLICATION half of the ceremonies above (gitvault.writer-
      // sufficient — the owner-gated half already happened at /confirm or
      // /repin). Composable primitive; no dedicated verb yet.
      "repos.publishPinManifestUpdate",
      // D202's explicit, audited "the writer signing key is gone" fact.
      // Owner+step-up declaration with no dedicated CLI verb yet.
      "repos.declareWriterAuthorityUnavailable",
      // D210 (rev 44): the recipient proof-of-open submission wire call.
      // `repos fsck` (JSON + `--human`) is the actual consumer-facing
      // surface — it calls this automatically in write mode and surfaces
      // the outcome as `open_proof`, no new flag needed. This method is the
      // manual/explicit escape hatch (resubmitting after fixing a local
      // keystore issue, or a grant-key-authenticated caller that already
      // resolved its own principal_id some other way, since GET
      // /agent/v1/whoami — fsck's own auto-resolution path — does not
      // accept a grant-key bearer); no dedicated CLI verb of its
      // own, same "composable primitive" pattern as confirmRecipient/
      // repinRecipient/publishPinManifestUpdate above.
      "repos.submitProofOfOpen",
      // rotateEpoch/rotateEpochForKeyRevocation/declareEpochSecretExposed/
      // declareRecipientKeyRevoked/acceptRecipientKeyChange share the ONE
      // `repos:access` CLI dispatch (`access repair`/`revoke-key`/
      // `declare-exposure`/`repin` sub-verbs) — same "shares the parent
      // command, no row of its own" pattern as `errors.watch`
      // above. declareRecipientKeyRevoked is additionally an internal step
      // `rotateEpochForKeyRevocation` composes (declare, then rotate off
      // the declaration's own returned counters). acceptRecipientKeyChange
      // (vault-agent-envelopes, `access repin`) moves the TOFU pin and
      // records the D197 confirmation receipt when a key-holder explicitly
      // accepts a recipient's changed key.
      "repos.rotateEpoch",
      "repos.rotateEpochForKeyRevocation",
      // rotateEpochForMemberRemoval (vault-multi-writer D6): the
      // writer-capable reason:"member_removed" rotation `org member rm`
      // drives inline on every vault the caller can, and `push()` runs
      // automatically on an outstanding removal — no dedicated CLI verb of
      // its own.
      "repos.rotateEpochForMemberRemoval",
      "repos.declareEpochSecretExposed",
      "repos.declareRecipientKeyRevoked",
      "repos.acceptRecipientKeyChange",
      // vault-client-round-trips design D3 (task 4.2): the local
      // object-cache eviction sweep `repos gc` calls as a best-effort side
      // effect — purely local housekeeping, no dedicated CLI verb.
      "repos.sweepObjectCache",
      // ─── Project events feed — org-wide union ──────────────────────────
      // Shares the `events list` CLI command (--org); no dedicated verb of its own.
      "events.listForOrg",
      // Agent messaging: join_room folds presence-listing + claim-listing into
      // the arrival call and read_room_messages folds get-one (message_id
      // param); scoped()/forProject() are addressing sugar the CLI uses
      // internally; getPresence is a drill-down with no verb of its own yet.
      "rooms.listPresences",
      "rooms.getPresence",
      "rooms.scoped",
      "rooms.forProject",
      // ─── Release error rollup — promote-gate watch ─────────────────────
      // `errors.list` / `errors.get` are SURFACE capabilities. watch rides
      // `run402 errors list --watch`; it has no verb/tool of its own.
      "errors.watch",
      // ─── SSR origin cache (v1.52) — flag-variants of `run402 cache invalidate` ─
      // Single-URL form is the canonical CLI; prefix/all/many are SDK-side
      // convenience methods that share the same CLI verb with flags.
      "cache.invalidatePrefix",
      "cache.invalidateAll",
      "cache.invalidateMany",
      // ─── Named-wallet server label sync (best-effort; private gateway companion) ─
      // Used internally by `run402 wallets new|rename|import` (gated) and by
      // direct SDK consumers; no dedicated CLI verb.
      "wallets.getLabel",
      "wallets.setLabel",
      // ─── call-shape conventions (sdk-positional-arg-ergonomics) ───────────
      // r.admin.org(id) / r.admin.project(id) are staff scope-handle
      // factories (the admin analog of r.project(id)/r.org(id)). Their methods
      // (pinLease/unpinLease, archive/reactivate/finance) reach the existing
      // admin SURFACE capabilities (lease-perpetual, archive, reactivate,
      // finance). `_setLeasePerpetual` is the shared impl behind both the
      // deprecated boolean `setLeasePerpetual` and the pinLease/unpinLease handle.
      "admin.org",
      "admin.project",
      "admin._setLeasePerpetual",
      // notification-channel-routing-telegram: admin.rules.update (PATCH
      // .../rules/:rule_id) is SDK-typed for programmatic PATCH null-vs-absent
      // semantics but has no dedicated CLI verb in v1 — the
      // shipped surface is list/create(add)/delete(rm) only (create + delete
      // already cover the "toggle enabled" / "change binding" use cases via
      // rm-then-add for the CLI's flag-based UX).
      "admin.rules.update",
      // ─── repos (r402s/v0, `r.repos` — the SDK keeps this name, design D1) ──
      // `get`/`forProject` are addressing sugar the verbs use internally
      // (`forProject` is the cold-restart lookup); `allHeads` is the paging
      // convenience behind the old standalone `verify`, superseded
      // operationally by `fsck`; `open` returns the raw protocol object for
      // consumers driving ref transactions or repair directly.
      "repos.get",
      "repos.forProject",
      "repos.allHeads",
      "repos.open",
      // `scaffoldRemote` is reached through `run402 init` (the scaffold
      // capability); `repos.init` has its own `run402 repos create` verb.
      "repos.scaffoldRemote",
      // D2 (repo-first-onramp task 2.2): `openOrCreate` is the lazy-allocation
      // primitive `repos.capture` and `git-remote-run402`'s push path compose
      // internally on `VAULT_UNRESOLVED` — it has no verb of its own,
      // the same way `open` and `init` already cover the explicit paths.
      "repos.openOrCreate",
      // `deploy` is the push-gated deploy — it belongs to the deploy surface
      // (`run402 deploy`), not to the repo verb group.
      "repos.deploy",
      // `drainOverrides` runs automatically on any later CLI invocation; it is
      // not a verb a caller reaches for.
      "repos.drainOverrides",
      // `restore` is the clone-back path, driven by `git-remote-run402`'s
      // fetch command rather than by a `run402 repos` subcommand.
      "repos.restore",
      // vault-byo-primary-bucket (design D4, task 3.4 — degraded read
      // mode, mirror half): `withDegradedRead` is the network-class-failure
      // fallback wrapper `git-remote-run402`'s `list`/`fetch` commands
      // compose around their own live materialize/restore calls — recovery
      // machinery, not a verb of its own, same family as `recoverStalePin`
      // below.
      "repos.withDegradedRead",
      // Same family, same composer: `degradedOpenFallback` is the open-time
      // half of the degraded read (the gateway was needed before any wrapped
      // read), and `postPublishCopies` is the capture-time mirror dual-push +
      // BYO chain copy `push()`/`deploy()` make, exposed so a plain `git push`
      // through the remote helper makes them too — recovery/copy machinery,
      // never verbs of their own.
      "repos.degradedOpenFallback",
      "repos.postPublishCopies",
      // Owner + step-up writes; the CLI reaches
      // them through the repo group's flags rather than dedicated verbs.
      // (`setPolicy` has its own `run402 repos policy` verb — see SURFACE.)
      "repos.completeOverride",
      "repos.acquireMaintenanceLease",
      // D6 named addressing (repo-first-onramp task 4): `forRepo` is
      // address-form resolution sugar the verbs use internally, the same
      // shape as `forProject` above; `resolveAddress` (pure read) and
      // `resolveOrCreateAddress` (open + push-to-create + id-pinning) are the
      // orchestration `git-remote-run402` and `repos capture`'s `push`
      // compose internally — no verb of their own, the same way `open` and
      // `openOrCreate` already cover the id-form paths.
      "repos.forRepo",
      "repos.resolveAddress",
      "repos.resolveOrCreateAddress",
      // vault-force-spelling-and-pin-fold: `recoverStalePin` is the
      // stale-pin heal `git-remote-run402`'s list path and `push`'s address
      // branch compose internally when an offline-pinned vault turns out to
      // be gone — recovery machinery, not a verb, same family as
      // `resolveOrCreateAddress` above.
      "repos.recoverStalePin",
      // kychee-com/run402#565: `planPush` is the real dry-run preview behind
      // `run402 repos capture --dry-run` (`repos_capture`'s OWN verb, a
      // flag-selected mode, not a second verb) and `git-remote-run402`'s
      // `option dry-run true` — no SURFACE row of its own, the same way
      // `deploy --no-rehearse` is a mode of `deploy` rather than a second
      // capability.
      "repos.planCapture",
      // kygit-handoff design D10: `repos handoff --list`/`--revoke` are
      // operational sub-flags of the ONE `repos_handoff` verb (SDK_BY_CAPABILITY
      // maps it to `repos.handoff`, the mint call) — same "flag-selected
      // mode, not a second verb" shape as `planPush` immediately above.
      "repos.listHandoffs",
      "repos.revokeHandoff",
      // kygit-invite design D9: `repos invite --list`/`--revoke` are the
      // SAME operational sub-flags of the ONE `repos_invite` verb
      // (SDK_BY_CAPABILITY maps it to `repos.invite`, the mint call) —
      // identical shape to `listHandoffs`/`revokeHandoff` immediately above.
      "repos.listInvites",
      "repos.revokeInvite",
      // repo-surface-consolidation D2: `git gc`'s own two halves, composed by
      // the CLI's `repos gc` (`repos_gc` maps to null in SDK_BY_CAPABILITY
      // above, same "compound-flow" shape as `up`/`init`/`repos_mirror`).
      "repos.compact",
      "repos.prune",
      // D4: the four methods behind the compound `run402 repos mirror`
      // (no-arg / <dest> / --off / --backfill) verb (`repos_mirror` maps to
      // null in SDK_BY_CAPABILITY above) — each has its OWN CLI action, just
      // not its own top-level SURFACE row. `mirrorVerify` is additionally
      // composed by `Repos.fsck({mirror: true})` (`repos_fsck`'s own
      // `--mirror` flag) — still no dedicated SURFACE row of its own.
      "repos.mirrorSet",
      "repos.mirrorRemove",
      "repos.mirrorStatus",
      "repos.mirrorSync",
      "repos.mirrorVerify",
      // repo-surface-consolidation D5/D7: `verify` and
      // `reconcileEnvelopeRecipients` are still public SDK API (external
      // programmatic consumers may call either directly), but neither has a
      // dedicated CLI capability anymore. `verify`'s CLI surface is
      // superseded operationally by `fsck` (`Repos.fsck`, which walks the
      // chain a different way to get the explicit pin_before/pin_after
      // fields D2 clause 5 requires). `reconcileEnvelopeRecipients`'s
      // explicit standalone CLI verb (`vault reconcile`) is REMOVED
      // outright (no successor — the workaround it performed is gone, not
      // renamed); the method itself is unchanged and still runs internally,
      // best-effort, from `push`/`deploy`'s own hooks.
      "repos.verify",
      "repos.reconcileEnvelopeRecipients",
      // vault-multi-writer (rev 47) task 5.7 — the writer-admission twin
      // of `reconcileEnvelopeRecipients` above, but UNLIKE that permanently
      // CLI-less sibling this one is TEMPORARILY uncovered: its CLI
      // surface is task 6.x (openspec/changes/vault-multi-writer tasks.md
      // §6 — `org members add`'s writer+envelope reconcile and `repos access
      // sync`'s new tail are both planned to compose it, likely without a
      // standalone verb of its own, mirroring how `repos.compactHeadroom`
      // above composes into `repos gc` rather than getting its own spelling)
      // — reachable via `r.repos.reconcile()` in the meantime. Remove
      // this entry once §6 lands and references it from SDK_BY_CAPABILITY.
      "repos.reconcile",
      // ─── function-runtime-rebuild (v1.69) — project-wide variant ──────────
      // `functions.rebuild` (single) is the canonical capability; `rebuildAll`
      // shares the `run402 functions rebuild --all` CLI verb, so it has no
      // dedicated leaf command.
      "functions.rebuildAll",
      // Durable runs expose waiting as an option on create/redrive in the CLI,
      // backed by the SDK polling helper rather than a separate surface noun.
      "functions.runs.wait",
      // Local idempotency-key helper used by agents/CLI; no gateway endpoint.
      "idempotency.fromParts",
      // One `identity link` CLI/OpenClaw group owns the rest of the public
      // dual-proof ceremony and lifecycle reads; begin is its SURFACE mapping.
      "identityLinks.nostr.complete",
      "identityLinks.list",
      "identityLinks.getProof",
      "identityLinks.revoke",
      // One goal-shaped CLI group owns the staged Buzz lifecycle.
      "buzz.adopt",
      "buzz.enroll",
      "buzz.humanAdoptionOffers.create",
      "buzz.humanAdoptionOffers.get",
      "buzz.humanAdoptionOffers.cancel",
      "buzz.humanAdoptionOffers.createAttempt",
      "buzz.humanAdoptions.create",
      "buzz.humanAdoptions.list",
      "buzz.humanAdoptions.get",
      "buzz.humanAdoptions.complete",
      "buzz.humanAdoptions.cancel",
      "buzz.communityInstallations.create",
      "buzz.communityInstallations.list",
      "buzz.communityInstallations.get",
      "buzz.communityInstallations.activate",
      "buzz.communityInstallations.update",
      "buzz.communityInstallations.revoke",
      "buzz.communityInstallations.discoverPublicDescriptors",
      "buzz.communityInstallations.getPublicDescriptor",
      "buzz.enrollments.list",
      "buzz.enrollments.get",
      // testAndWait composes test + poll; the CLI spells it
      // `buzz notifications test --wait` (the escalations.raiseAndWait precedent).
      "buzz.notifications.testAndWait",
      // Portable archive export uses `archives.export` as the happy path.
      // create/wait are low-level operation primitives used by the CLI
      // wrappers to surface progress and idempotent resume behavior.
      "archives.create",
      "archives.wait",
      // Snapshot restore is a two-step handshake. The SURFACE capability maps
      // to the mutating confirm call; restorePlan is the typed planning half
      // used by the CLI before confirming the same endpoint.
      "snapshots.restorePlan",
      // ─── sign-in session ─────────────────────────────────────────────────
      // `run402 login` builds the authorize URL (mapped: exchangeCliToken);
      // `run402 login --device` runs deviceStart + devicePoll. All share the
      // `login` verb, like the cache.invalidate* variants above.
      "session.buildCliAuthorizeUrl",
      "session.deviceStart",
      "session.devicePoll",
      // `run402 approve`: requestChallenge is mapped to `approve`;
      // exchangeClaimCode is the second half of the same loopback dance.
      "writeApproval.exchangeClaimCode",
      // The account reads: `run402 orgs list` joins me.overview into the
      // membership list (`list_orgs` maps to orgs.list); `run402 doctor` and
      // `whoami` read me.status. Neither has a verb of its own.
      "me.overview",
      "me.status",
      // `r.session.*` is also the browser/console sign-in client surface
      // (email magic link / passkey / OAuth / lifecycle / step-up / recovery /
      // authenticators). Browser-interactive by design — no
      // dedicated CLI verb (the CLI sign-in is the loopback ceremony above;
      // `whoami` is also called by `run402 login` and `run402 whoami`).
      "session.email",
      "session.verifyEmail",
      "session.passkeyOptions",
      "session.passkeyVerify",
      "session.oauthUrl",
      "session.consumeRecoveryCode",
      "session.whoami",
      "session.refresh",
      "session.enrollPasskeyOptions",
      "session.enrollPasskeyVerify",
      "session.stepUpOptions",
      "session.stepUpVerify",
      "session.issueRecoveryCodes",
      "session.listAuthenticators",
      "session.revokeAuthenticator",
      // Email-code verification is the second credential shape accepted by
      // the existing auth:verify CLI/OpenClaw command, whose canonical SURFACE
      // mapping remains verifyMagicLink.
      "auth.verifyEmailCode",
      // SDK action runner exposes the generic dispatcher alongside the typed
      // `actions.up` convenience mapped to the CLI `up` capability.
      "actions.run",
      // App install state is the convergence ledger used by `run402 up`; it is
      // intentionally not a separate user-facing CLI command surface.
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

// ─── CLI/MCP SDK-boundary guard (add-vault task 5.0) ──────────────────────
//
// "The SDK owns ALL the smarts; the CLI is a thin shim." The client-surface
// spec makes that architectural law: every piece of vault protocol behaviour —
// crypto core, keystore, creation journal, snapshot + capture, publication
// state machines, ref transactions, verification budget, token exchange,
// repair — is implemented ONCE in `@run402/sdk`, and `run402 repos …`,
// `git-remote-run402`, and the MCP tools are adapters: argument parsing, TTY
// output, exit codes, and local file I/O only.
//
// This gate is what keeps that honest. Without it the drift is silent and
// one-directional: a shim that reaches for `node:crypto` or `fetch` once
// becomes a second implementation of the protocol, and then the two lineages
// disagree in production rather than in CI.
//
// CARVE-OUT, deliberate and permanent: `r402s-verify` (the Rust crate at
// `r402s-verify/`) is the INDEPENDENT SECOND LINEAGE. It implements the
// protocol from scratch — its own HPKE, its own strict parser, its own
// Ed25519 — precisely so a differential disagreement with the SDK is
// reportable evidence rather than a shared blind spot. It is not TypeScript,
// it is not scanned here, and it must never be "aligned" with this rule.

/** Files that must contain no protocol implementation of their own. */
const SHIM_SOURCES = [
  "cli/lib/vault-scaffold.mjs",
  "cli/lib/vault-target.mjs",
  // Pure data ledger (openspec/changes/kygit-page-truth-gate design D1) —
  // no imports, no gateway calls, nothing for FORBIDDEN_SHIM_IMPORTS/CALLS
  // to catch. Listed here only to satisfy SHIM_DISCOVERY_DIRS' name-based
  // sweep; it is not a request/response shim.
  "cli/lib/vault-capabilities.mjs",
  "cli/git-remote-run402.mjs",
  // vault-persistent-helper: the resident engine + its process entry.
  // Shims by the gate's definition (protocol-adjacent, must never grow
  // their own crypto/HTTP/git behavior) — the daemon FORWARDS sessions
  // into the SDK-backed session module, it implements nothing.
  "cli/lib/remote-helper-session.mjs",
  "cli/lib/vault-daemon.mjs",
  "cli/lib/vault-daemon-run.mjs",
];

/**
 * Anything under these directories whose name mentions vault is a shim by
 * construction and must be listed above. This is the half that survives a
 * rename: an explicit list catches a deletion, discovery catches an addition.
 */
const SHIM_DISCOVERY_DIRS = ["cli/lib", "src/tools", "openclaw/scripts"];

/**
 * Imports a shim may NOT reach for. Each entry is a capability the SDK already
 * owns; importing it in a shim means the shim is about to reimplement it.
 */
const FORBIDDEN_SHIM_IMPORTS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\bfrom\s+["']node:crypto["']/, why: "hashing/signing is the SDK's crypto core" },
  { pattern: /\brequire\(["']node:crypto["']\)/, why: "hashing/signing is the SDK's crypto core" },
  { pattern: /\bfrom\s+["']@noble\//, why: "Ed25519/X25519 belong to the SDK crypto core" },
  { pattern: /\bfrom\s+["']@hpke\//, why: "HPKE belongs to the SDK crypto core" },
  { pattern: /\bfrom\s+["']undici["']/, why: "all HTTP goes through the SDK kernel" },
  { pattern: /\bfrom\s+["']node:https?["']/, why: "all HTTP goes through the SDK kernel" },
  { pattern: /\bfrom\s+["']isomorphic-git["']/, why: "git plumbing belongs to the SDK's hardened-git layer" },
  { pattern: /\bfrom\s+["']simple-git["']/, why: "git plumbing belongs to the SDK's hardened-git layer" },
  // A shim that spawns git directly has re-implemented the hardened-git
  // contract (cleared GIT_* env, no user config, empty hooks path, filters
  // structurally disabled) — the one place a mistake silently runs a hostile
  // filter on a captured path.
  { pattern: /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*["'`]git\b/, why: "git must be invoked through the SDK's hardened-git layer, never spawned directly" },
];

/** Bare network calls: an adapter never talks to the gateway on its own. */
const FORBIDDEN_SHIM_CALLS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /(^|[^.\w])fetch\s*\(/m, why: "all HTTP goes through the SDK kernel (getSdk()), never a bare fetch" },
  { pattern: /\bnew\s+XMLHttpRequest\b/, why: "all HTTP goes through the SDK kernel" },
];

describe("CLI/MCP SDK-boundary guard", () => {
  it("keeps production interface code from bypassing the SDK for gateway calls", () => {
    const allowlist = new Map<string, RegExp[]>([
      // The v2.1.0 unified-apply pipeline removed every presigned-PUT
      // call in cli/lib/assets.mjs — it now delegates to `sdk.assets.put`
      // (which routes through the apply hero). That allowlist entry is kept
      // out so a regression that reintroduces raw HTTP fails the guard.
      ["cli/lib/wallets.mjs", [/\bfetch\(TEMPO_RPC\b/]], // Tempo faucet/RPC
      ["cli/lib/ci.mjs", [/\bfetch\(`https:\/\/api\.github\.com\/repos\//]], // GitHub repository lookup
      // These are the intentional SDK buyer calls added by GH-607. The guard's
      // lexical `fetch(` scan cannot distinguish `sdk.pay.fetch` from raw HTTP.
      ["cli/lib/pay.mjs", [/\.pay\.fetch\(/]],
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

  it("keeps server-capable custom-domain handlers from preflighting local project-key cache", () => {
    const serverCapableDomainHandlers = [
      "cli/lib/domains.mjs",
    ];
    const forbiddenLookup = /\b(?:getProject|findProject|loadKeyStore|projectsFile|projectCredentialsFile)\s*\(/g;
    const violations: string[] = [];

    for (const relativePath of serverCapableDomainHandlers) {
      const source = readFileSync(join(__dirname, relativePath), "utf-8");
      const matches = [...source.matchAll(forbiddenLookup)].map((match) => match[0]);
      if (matches.length > 0) {
        violations.push(`${relativePath}: ${matches.join(", ")}`);
      }
    }

    assert.deepEqual(
      violations,
      [],
      "Server-capable domain handlers must not prove project existence by reading local project-key cache. " +
        "They should resolve the project id and call the SDK domain namespace.",
    );
  });
  it("every declared shim source exists — a renamed file must not silently drop out of the gate", () => {
    const missing = SHIM_SOURCES.filter((f) => !existsSync(join(__dirname, f)));
    assert.deepEqual(
      missing,
      [],
      "SHIM_SOURCES names files that do not exist. If a shim was renamed, update this list — " +
        `do not let it fall out of the boundary gate: ${missing.join(", ")}`,
    );
  });

  it("no vault shim escapes the gate by being added under a new name", () => {
    const found: string[] = [];
    for (const dir of SHIM_DISCOVERY_DIRS) {
      const abs = join(__dirname, dir);
      if (!existsSync(abs)) continue;
      for (const name of readdirSync(abs)) {
        if (!/vault/i.test(name)) continue;
        if (name.endsWith(".test.ts") || name.endsWith(".test.mjs")) continue;
        found.push(`${dir}/${name}`);
      }
    }
    const untracked = found.filter((f) => !SHIM_SOURCES.includes(f));
    assert.deepEqual(
      untracked,
      [],
      `New vault shim source(s) are not in SHIM_SOURCES, so the boundary gate is not scanning them. ` +
        `Add them: ${untracked.join(", ")}`,
    );
  });

  it("shims import only the SDK and stdlib — never crypto, HTTP, or git libraries directly", () => {
    const violations: string[] = [];
    for (const file of SHIM_SOURCES) {
      const path = join(__dirname, file);
      if (!existsSync(path)) continue;
      const src = readFileSync(path, "utf-8");
      for (const { pattern, why } of FORBIDDEN_SHIM_IMPORTS) {
        if (pattern.test(src)) violations.push(`${file}: ${pattern} — ${why}`);
      }
      for (const { pattern, why } of FORBIDDEN_SHIM_CALLS) {
        if (pattern.test(src)) violations.push(`${file}: ${pattern} — ${why}`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      "A vault shim reached past the SDK. The SDK owns all protocol logic; the shim does argument " +
        "parsing, TTY output, exit codes, and local file I/O only. Move the behaviour into " +
        `sdk/src/namespaces/repos.ts (or sdk/src/node/vault-*.ts) and call it:\n  ${violations.join("\n  ")}`,
    );
  });

  it("r402s-verify is NOT scanned — it is the independent second lineage, by design", () => {
    // Stated as an executable assertion so a future edit that "tidies" the
    // Rust crate into this list has to argue with a test that explains why
    // that would destroy the differential-verification property.
    assert.equal(
      SHIM_SOURCES.some((f) => f.startsWith("r402s-verify/")),
      false,
      "r402s-verify implements the protocol independently on purpose — sharing implementation code with " +
        "the SDK would let one defect hide in both lineages at once. Never add it to SHIM_SOURCES.",
    );
  });
});

function productionInterfaceFiles(): string[] {
  const cliLib = join(__dirname, "cli/lib");
  return [
    ...readdirSync(cliLib)
      .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
      .map((name) => join(cliLib, name)),
    // The whole MCP server: the eight tools, the sandbox, and the chain proxy.
    ...sourceFiles(join(__dirname, "src")),
    // `git-remote-run402` is a production interface too, and it lives at the
    // CLI package root rather than under `cli/lib/`, so a directory scan alone
    // would leave the one binary git itself executes unguarded.
    ...(existsSync(join(__dirname, "cli/git-remote-run402.mjs")) ? [join(__dirname, "cli/git-remote-run402.mjs")] : []),
  ].sort();
}

describe("SURFACE consistency", () => {
  it("has no duplicate capability IDs", () => {
    const ids = SURFACE.map(c => c.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(dupes, [], `Duplicate capability IDs: ${dupes.join(", ")}`);
  });

  it("has no duplicate CLI commands", () => {
    const cmds = SURFACE.map(c => c.cli).filter(Boolean);
    const dupes = cmds.filter((c, i) => cmds.indexOf(c) !== i);
    assert.deepEqual(dupes, [], `Duplicate CLI commands: ${dupes.join(", ")}`);
  });

  /**
   * Capabilities deliberately reachable through the SDK only, each with the
   * condition that ends the exception.
   *
   * The rule this bends is a good one — a gateway capability with no
   * agent-facing verb is invisible to agents — so an entry here is a dated
   * decision, not a parking space. State what unblocks it.
   */
  const SDK_ONLY_FOR_NOW: Record<string, string> = {};

  it("every capability is covered by at least one interface", () => {
    // The SDK counts as an interface: MCP reaches every SDK method through `run`.
    const uncovered = SURFACE.filter(c => !c.cli && !c.openclaw && !SDK_BY_CAPABILITY[c.id] && !(c.id in SDK_ONLY_FOR_NOW));
    assert.deepEqual(
      uncovered.map(c => c.id),
      [],
      `Capabilities with no implementation in any interface: ${uncovered.map(c => c.id).join(", ")}`,
    );
  });

  it("every SDK-only exception names an SDK method and a condition that ends it", () => {
    for (const [id, reason] of Object.entries(SDK_ONLY_FOR_NOW)) {
      assert.ok(SURFACE.some(c => c.id === id), `${id} is allowlisted but not in SURFACE`);
      assert.ok(SDK_BY_CAPABILITY[id], `${id} is SDK-only but maps to no SDK method — then it is reachable by nothing`);
      assert.match(reason, /SDK: [a-z]/i, `SDK_ONLY_FOR_NOW["${id}"] must name the SDK method that covers it`);
    }
  });
});

describe("deploy route surface alignment", () => {
  it("keeps route authoring documented across public agent surfaces", () => {
    // `llms.txt` is the budgeted FRONT DOOR (first-deploy-front-door spec):
    // one command, one file, two links — it links the references below and
    // deliberately carries no route-authoring material of its own.
    const requiredFiles = [
      "README.md",
      "SKILL.md",
      "openclaw/SKILL.md",
      "cli/README.md",
      "cli/llms-cli-full.txt",
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
      { file: "cli/llms-cli-full.txt", patterns: [/--route-scope/, /CI_ROUTE_SCOPE_DENIED/] },
      { file: "sdk/README.md", patterns: [/route_scopes/, /CI_ROUTE_SCOPE_DENIED/] },
      { file: "sdk/llms-sdk.txt", patterns: [/route_scopes/, /CI_ROUTE_SCOPE_DENIED/] },
      { file: "llms-mcp.txt", patterns: [/ci\.createBinding/, /route_scopes/, /CI_ROUTE_SCOPE_DENIED/] },
      { file: "SKILL.md", patterns: [/--route-scope/, /CI_ROUTE_SCOPE_DENIED/] },
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
          [/run402 deploy resolve/, "CLI resolve command"],
          [/run402 up verify/, "app verify rerun command"],
          [/edge_propagation/, "edge propagation diagnostics"],
          [/propagation_pending/, "propagation pending app status"],
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
          [/run402 deploy resolve/, "CLI resolve command"],
          [/run402 up verify/, "app verify rerun command"],
          [/edge_propagation/, "edge propagation diagnostics"],
          [/propagation_pending/, "propagation pending app status"],
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
          [/apply\.resolve/, "resolve as a run snippet"],
          [/run402 up verify/, "app verify rerun command"],
          [/edge_propagation/, "edge propagation diagnostics"],
          [/propagation_pending/, "propagation pending app status"],
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
          [/run402 deploy resolve/, "CLI resolve command"],
          [/run402 up verify/, "app verify rerun command"],
          [/edge_propagation/, "edge propagation diagnostics"],
          [/propagation_pending/, "propagation pending app status"],
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
        file: "cli/llms-cli-full.txt",
        patterns: [
          [/site\.public_paths/, "site public path authoring"],
          [/\/events\.html.*not public|not public.*\/events\.html/, "explicit mode hides backing asset filename"],
          [/static_public_paths/, "static public path inventory"],
          [/reachability_authority/, "reachability authority field"],
          [/run402 deploy resolve/, "CLI resolve command"],
          [/run402 up verify/, "app verify rerun command"],
          [/edge_propagation/, "edge propagation diagnostics"],
          [/propagation_pending/, "propagation pending app status"],
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
          [/verifyOnly/, "SDK verify-only option"],
          [/edge_propagation/, "edge propagation diagnostics"],
          [/propagation_pending/, "propagation pending app status"],
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
          [/verifyOnly/, "SDK verify-only option"],
          [/edge_propagation/, "edge propagation diagnostics"],
          [/propagation_pending/, "propagation pending app status"],
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
          [/run402 deploy resolve/, "CLI resolve command"],
          [/run402 up verify/, "app verify rerun command"],
          [/edge_propagation/, "edge propagation diagnostics"],
          [/propagation_pending/, "propagation pending app status"],
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
          [/run402 deploy resolve/, "CLI resolve command"],
          [/run402 up verify/, "app verify rerun command"],
          [/edge_propagation/, "edge propagation diagnostics"],
          [/"type": "static", "file": "events\.html"/, "static route target JSON"],
          [/static_assets/, "static asset diff counters"],
          [/static_manifest_sha256/, "static manifest digest"],
        ],
      },
      {
        file: "docs/quality/maintenance-map.md",
        patterns: [
          [/site\.public_paths/, "site public path authoring"],
          [/static_public_paths/, "static public path inventory"],
          [/reachability_authority/, "reachability authority field"],
          [/stable static asset identity \/ public URL diagnostics/, "documentation checklist row"],
          [/run402 deploy resolve/, "CLI resolve command"],
          [/run402 up verify/, "app verify rerun command"],
          [/edge_propagation/, "edge propagation diagnostics"],
          [/propagation_pending/, "propagation pending app status"],
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
      "cli/llms-cli-full.txt",
      "sdk/README.md",
      "sdk/llms-sdk.txt",
      "openclaw/SKILL.md",
      "openclaw/README.md",
      "docs/quality/maintenance-map.md",
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

  it("keeps SDK route types and the MCP deploy tool in sync", () => {
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
      readFileSync(join(__dirname, "cli/llms-cli-full.txt"), "utf-8"),
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
      file: "cli/llms-cli-full.txt",
      patterns: [
        [/release-spec\.v1\.json/, "ReleaseSpec schema URL"],
        [/--stdin/, "secret stdin guidance"],
        [/--allow-warning <code>/, "warning-code acknowledgement flag"],
        [/--final-only/, "final-only deploy output"],
        [/cli\.update_available/, "CLI stale-version update notice"],
        [/doctor --refresh/, "CLI live update check"],
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
        [/Run402-Client/, "SDK client metadata header"],
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
        [/--allow-warning/, "CLI skill warning-code acknowledgement"],
        [/acknowledge_readonly/, "MCP skill readonly route acknowledgement"],
        [/Function timeout/, "tier caps"],
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
        [/Run402-Client/, "SDK README client metadata header"],
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
    assert.match(schemaText, /capabilities/, "schema must document function capabilities");
    assert.match(schemaText, /require_auth/, "schema must document function auth gates");
    assert.match(schemaText, /"class": \{ "enum": \["ssr", "standard"\] \}/, "schema must document SSR function class");

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
    const cli = SURFACE.filter(c => c.cli);
    const sdkOnly = SURFACE.filter(c => !c.cli && SDK_BY_CAPABILITY[c.id]);

    const lines = [
      `\n  Coverage: ${cli.length} with a CLI command, ${sdkOnly.length} SDK-only (reached from MCP through run)`,
      ``,
      `  SDK-only (no CLI/OpenClaw command):`,
      ...sdkOnly.map(c => `    - ${SDK_BY_CAPABILITY[c.id]} (${c.endpoint})`),
    ];

    // This test always passes — it's purely informational
    console.log(lines.join("\n"));
    assert.ok(true);
  });
});

describe("agent-skills discovery index", () => {
  // The public repo is authoritative for both first-party artifact bytes and
  // the committed discovery metadata (regenerate with the builder).
  it("advertises the generic and Buzz skills as content-addressed apex artifacts", () => {
    const skill = readFileSync(join(__dirname, "SKILL.md"), "utf-8");
    const expected = "sha256:" + createHash("sha256").update(skill, "utf8").digest("hex");
    const index = JSON.parse(
      readFileSync(join(__dirname, ".well-known/agent-skills/index.json"), "utf-8"),
    );
    assert.deepEqual(index.skills.map(({ name, type }: { name: string; type: string }) => ({ name, type })), [
      { name: "run402", type: "skill-md" },
      { name: "run402-buzz", type: "archive" },
    ]);
    const entry = index.skills.find(({ name }: { name: string }) => name === "run402");
    assert.equal(
      entry.digest,
      expected,
      "index digest must equal sha256(SKILL.md) — run `node scripts/build-agent-skills-index.mjs`",
    );
    for (const advertised of index.skills) {
      assert.match(advertised.url, new RegExp(`^https://run402\\.com/skills/${advertised.name}/[a-f0-9]{64}/`));
      assert.match(advertised.digest, /^sha256:[a-f0-9]{64}$/);
      assert.ok(advertised.url.includes(advertised.digest.slice("sha256:".length)));
    }
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
    "cli/llms-cli.txt", "cli/llms-cli-full.txt", "sdk/llms-sdk.txt",
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
