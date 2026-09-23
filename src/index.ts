#!/usr/bin/env node
/**
 * run402-mcp: eight tools and no others.
 *
 * `up` and `deploy` are the first-deploy front door; `status`, `whoami`, and
 * `doctor` answer "who am I and is this machine healthy" before any docs are
 * read; `docs` serves the SDK reference that ships in this package; `run`
 * executes a TypeScript snippet against the SDK in a sandbox, which is how
 * every other operation is reached; `expand_result` pages a stored result.
 * The set is pinned by `MCP_TOOLS` in sync.test.ts.
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { selectWallet } from "../sdk/dist/node/index.js";

import { upSchema, handleUp } from "./tools/up.js";
import { deploySchema, handleDeploy } from "./tools/deploy.js";
import { statusSchema, handleStatus } from "./tools/status.js";
import { whoamiSchema, handleWhoami } from "./tools/whoami.js";
import { doctorSchema, handleDoctor } from "./tools/doctor.js";
import { docsSchema, handleDocs } from "./tools/docs.js";
import { runSchema, handleRun } from "./tools/run.js";
import { expandResultSchema, handleExpandResult } from "./tools/expand-result.js";

function currentPackageVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : "0.0.0";
}

// The wallet this server acts as, resolved as the CLI resolves it with no
// flag: RUN402_WALLET, else the nearest .run402.json binding from the working
// directory, else the global default, else `default`. The environment wins a
// conflict with a binding (status reports the conflict). A missing wallet is
// not fatal: status and doctor say what to run.
try {
  selectWallet({ allowMissing: true, allowConflict: true });
} catch (err) {
  console.error(`run402-mcp: wallet selection: ${err instanceof Error ? err.message : String(err)}`);
}

const server = new McpServer({
  name: "run402",
  version: currentPackageVersion(),
});

const RUN_HINT = "Any other operation is a `run` snippet against `r`, the Node SDK client; `docs` is its reference.";

server.tool(
  "up",
  "Plan or run the canonical app-aware `run402 up` workflow from a local path or repo URL: any missing setup (wallet, tier, project, workspace link), then the deploy. Delegates to the SDK and returns the shared up result envelope with graph steps, resources, diagnostics, and next_actions. `deploy` only deploys.",
  upSchema,
  async (args) => handleUp(args),
);

server.tool(
  "deploy",
  "Unified apply primitive. Accepts a structured ReleaseSpec — database (migrations + expose), value-free secrets.require/delete declarations, functions, site, site.public_paths, site.embedding (framing opt-in by catalog key, e.g. { frame_ancestors: ['localhost'] }; null = deny), subdomains, and routes.replace web routes — with explicit replace vs patch semantics per resource. Migration entries use id for immutable versioned SQL or name for generated/idempotent content-tracked SQL; name compiles client-side to <name>_<sha256(sql)[0:16]>. Use site.public_paths for clean static URLs such as /events backed by release asset events.html; explicit mode does not expose /events.html unless separately declared, while mode: 'implicit' restores filename-derived reachability and can widen access. Route entries map exact/final-wildcard browser paths like /admin and /admin/* to Node 22 Fetch Request -> Response functions, or exact GET/HEAD method-aware static aliases such as /events to { type: 'static', file: 'events.html' }; intentional read-only GET/HEAD wildcard function routes may set acknowledge_readonly: true. Direct /functions/v1/:name remains API-key protected. Secret values are set first with `r.secrets.set` (a `run` snippet) or `run402 secrets set`, never placed in deploy specs. All bytes ride through CAS (no inline-body cap). Returns release_id, URLs, warnings, and a structured progress-event log. Stops before upload/commit on confirmation-required warnings unless reviewed codes are passed with allow_warning_codes or allow_warnings is true.",
  deploySchema,
  async (args) => handleDeploy(args),
);

server.tool(
  "status",
  `The organization's state as this server's wallet sees it (r.status()): the wallet's local_label, server_label, and address, the tier and its lease, the allowance, the projects, and the active project. Never key material. ${RUN_HINT}`,
  statusSchema,
  async () => handleStatus(),
);

server.tool(
  "whoami",
  `The remote identity (r.orgs.whoami()): the control-plane principal this server's wallet resolves to, its active authenticator and linked identities, its org memberships, and the sign-in session grade (none for a wallet). For the local wallet use status. ${RUN_HINT}`,
  whoamiSchema,
  async () => handleWhoami(),
);

server.tool(
  "doctor",
  `Local health and configuration diagnostics (r.doctor()): { ok, blocking[], warnings[], checks[] }, the same report as \`run402 doctor\`. ok is false only on a blocking finding. ${RUN_HINT}`,
  doctorSchema,
  async (args) => handleDoctor(args),
);

server.tool(
  "docs",
  `The SDK reference for \`run\` snippets, from the copy shipped in this package, so it matches the SDK the snippet runs against. No arguments: the run primer, the r namespace table, and the topics. topic: one namespace or section (assets, project.apply, rooms, local-state) or sdk for all of it; search: sections containing every word. Long answers are a window plus a ref for expand_result. ${RUN_HINT}`,
  docsSchema,
  async (args) => handleDocs(args),
);

server.tool(
  "run",
  "Run a TypeScript snippet against the SDK in a sandbox. `r` is the Node SDK client (@run402/sdk/node); call `docs` for its reference. The code is the body of an async function: await r chains, and the value of the last expression (or a return) is the result, e.g. `(await r.projects.list()).projects.map((p) => p.id)`. No filesystem, process, fetch, timers, or imports; console is captured. Returns { status, value, value_ref, shown, total, logs, logs_ref, calls, duration_ms, wallet, error? }; a large value is stored whole and expand_result pages it. Operations that return or consume a one-time secret (grant keys, Handoff and Invite Keys, project credentials, wallet keys) refuse with SECRET_REQUIRES_CLI naming the exact CLI command to hand the person. Any other operation is a run snippet against r.",
  runSchema,
  async (args) => handleRun(args),
);

server.tool(
  "expand_result",
  "Fetch more of a result a previous tool showed you only a window of. Tools on this surface truncate the VIEW, never the DATA: when one prints a ref together with shown and total, the full result is held behind that ref and this is how you read the rest of it. Pass the ref plus offset and limit to page through it. Refs live in this server process only — they expire after 30 minutes and only the most recent handful are kept, so re-run the producing tool rather than storing a ref across sessions. A result that carried a secret is never retained and never has a ref, so nothing here can hand one back.",
  expandResultSchema,
  async (args) => handleExpandResult(args),
);

const transport = new StdioServerTransport();
await server.connect(transport);
