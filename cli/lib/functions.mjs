import { readFileSync } from "fs";
import { findProject, API } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, hasHelp, normalizeArgv, parseIntegerFlag, validateRegularFile } from "./argparse.mjs";

const FUNCTION_LOG_REQUEST_ID_RE = /^req_[A-Za-z0-9_-]{4,128}$/;

const HELP = `run402 functions — Manage serverless functions

Usage:
  run402 functions <subcommand> [args...]

Subcommands:
  deploy <id> <name> --file <file> [--timeout <s>] [--memory <mb>] [--deps <pkg,...>] [--schedule <cron>]
                                       Deploy a function to a project
  invoke <id> <name> [--method <M>] [--body <json>]
                                       Invoke a deployed function
  logs   <id> <name> [--tail <n>] [--since <ts>] [--request-id <req_...>] [--follow]
                                       Get function logs
  update <id> <name> [--schedule <cron>] [--schedule-remove] [--timeout <s>] [--memory <mb>]
                                       Update function schedule or config without re-deploying
  list   <id>                          List all functions for a project
  delete <id> <name>                   Delete a function

Examples:
  run402 functions deploy prj_abc123 stripe-webhook --file handler.ts
  run402 functions deploy prj_abc123 send-reminders --file remind.ts --schedule '*/15 * * * *'
  run402 functions deploy prj_abc123 send-reminders --file remind.ts --schedule ''   # remove schedule
  run402 functions invoke prj_abc123 stripe-webhook --body '{"event":"test"}'
  run402 functions logs prj_abc123 stripe-webhook --tail 100
  run402 functions logs prj_abc123 stripe-webhook --since 2026-03-29T14:00:00Z
  run402 functions logs prj_abc123 stripe-webhook --request-id req_abc123
  run402 functions logs prj_abc123 stripe-webhook --follow
  run402 functions update prj_abc123 send-reminders --schedule '0 */4 * * *'
  run402 functions update prj_abc123 send-reminders --schedule-remove
  run402 functions update prj_abc123 my-func --timeout 15 --memory 256
  run402 functions list prj_abc123
  run402 functions delete prj_abc123 stripe-webhook

Notes:
  - Code must export a default async function: export default async (req: Request) => Response
  - Deploy may require payment if the project lease has expired
`;

const SUB_HELP = {
  deploy: `run402 functions deploy — Deploy a function to a project

Usage:
  run402 functions deploy <project_id> <name> --file <file> [options]

Arguments:
  <project_id>        Target project ID
  <name>              Function name (used in the invoke URL path)

Options:
  --file <file>       Required: path to the function source file
  --timeout <s>       Runtime timeout in seconds
  --memory <mb>       Memory in MB
  --deps <spec,...>   Comma-separated npm specs to install and bundle.
                      Bare names (e.g. 'lodash') resolve to latest at
                      deploy time; pinned ('lodash@4.17.21') or range
                      ('date-fns@^3.0.0') specs are honored verbatim.
                      '@run402/functions' is auto-bundled and is rejected
                      here; the legacy 'run402-functions' name is also
                      rejected. Max 30 entries, max 200 chars per spec.
                      Native binary modules (sharp, canvas, native bcrypt)
                      are rejected.
  --schedule <cron>   Cron schedule; pass '' to clear an existing schedule

Notes:
  Code must export a default async function:
    export default async (req: Request) => Response
  Deploy may require payment if the project lease has expired.

  The deploy response includes:
  - runtime_version: the bundled @run402/functions version (e.g. "1.48.0")
  - deps_resolved: map of each --deps name to the actually-installed
    concrete version (e.g. {"lodash":"4.17.21"})
  - warnings (optional, top-level, sibling to the record): non-fatal
    notes such as bundle-size advisories

Examples:
  run402 functions deploy prj_abc123 stripe-webhook --file handler.ts
  run402 functions deploy prj_abc123 send-reminders --file remind.ts \\
    --schedule '*/15 * * * *'
  run402 functions deploy prj_abc123 send-reminders --file remind.ts --schedule ''
`,
  invoke: `run402 functions invoke — Invoke a deployed function

Usage:
  run402 functions invoke <project_id> <name> [options]

Arguments:
  <project_id>        Target project ID
  <name>              Function name

Options:
  --method <M>        HTTP method (default POST)
  --body <json>       Request body (ignored for GET/HEAD)

Examples:
  run402 functions invoke prj_abc123 stripe-webhook --body '{"event":"test"}'
  run402 functions invoke prj_abc123 ping --method GET
`,
  logs: `run402 functions logs — Fetch or tail function logs

Usage:
  run402 functions logs <project_id> <name> [options]

Arguments:
  <project_id>        Target project ID
  <name>              Function name

Options:
  --tail <n>          Number of most-recent entries (default 50)
  --since <ts>        ISO timestamp or epoch ms; only entries after this
  --request-id <id>   Only entries correlated to this req_... request id
  --follow            Poll every 3s and stream new entries (Ctrl-C to stop)

Examples:
  run402 functions logs prj_abc123 stripe-webhook --tail 100
  run402 functions logs prj_abc123 stripe-webhook --since 2026-03-29T14:00:00Z
  run402 functions logs prj_abc123 stripe-webhook --request-id req_abc123
  run402 functions logs prj_abc123 stripe-webhook --follow
`,
  update: `run402 functions update — Update function config without re-deploying

Usage:
  run402 functions update <project_id> <name> [options]

Arguments:
  <project_id>        Target project ID
  <name>              Function name

Options:
  --schedule <cron>   New cron schedule (pass '' to clear)
  --schedule-remove   Explicitly remove the schedule
  --timeout <s>       Runtime timeout in seconds
  --memory <mb>       Memory in MB

Notes:
  Must provide at least one of the options above.

Examples:
  run402 functions update prj_abc123 send-reminders --schedule '0 */4 * * *'
  run402 functions update prj_abc123 send-reminders --schedule-remove
  run402 functions update prj_abc123 my-func --timeout 15 --memory 256
`,
  list: `run402 functions list — List all functions for a project

Usage:
  run402 functions list <project_id>

Arguments:
  <project_id>        Target project ID

Examples:
  run402 functions list prj_abc123
`,
  delete: `run402 functions delete — Delete a function from a project

Usage:
  run402 functions delete <project_id> <name>

Arguments:
  <project_id>        Target project ID
  <name>              Function name to delete

Examples:
  run402 functions delete prj_abc123 stripe-webhook
`,
};

async function deploy(projectId, name, args) {
  assertRequiredProjectAndName(projectId, name, "run402 functions deploy <project_id> <name> --file <file>");
  assertKnownFlags(args, ["--file", "--timeout", "--memory", "--deps", "--schedule", "--help", "-h"], ["--file", "--timeout", "--memory", "--deps", "--schedule"]);
  const opts = { file: null, timeout: undefined, memory: undefined, deps: undefined, schedule: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) opts.file = args[++i];
    if (args[i] === "--timeout") opts.timeout = parseIntegerFlag("--timeout", args[++i], { min: 1 });
    if (args[i] === "--memory") opts.memory = parseIntegerFlag("--memory", args[++i], { min: 1 });
    if (args[i] === "--deps" && args[i + 1]) opts.deps = args[++i].split(",");
    if (args[i] === "--schedule" && i + 1 < args.length) opts.schedule = args[++i];
  }
  if (!opts.file) {
    fail({ code: "BAD_USAGE", message: "Missing --file <file>" });
  }
  validateRegularFile(opts.file, "--file");
  const code = readFileSync(opts.file, "utf-8");

  const deployOpts = { name, code };
  if (opts.timeout !== undefined || opts.memory !== undefined) {
    deployOpts.config = {};
    if (opts.timeout !== undefined) deployOpts.config.timeout = opts.timeout;
    if (opts.memory !== undefined) deployOpts.config.memory = opts.memory;
  }
  if (opts.deps !== undefined) deployOpts.deps = opts.deps;
  if (opts.schedule !== undefined) deployOpts.schedule = opts.schedule === "" ? null : opts.schedule;

  try {
    const data = await getSdk().functions.deploy(projectId, deployOpts);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function invoke(projectId, name, args) {
  assertRequiredProjectAndName(projectId, name, "run402 functions invoke <project_id> <name> [--method <M>] [--body <json>]");
  assertKnownFlags(args, ["--method", "--body", "--help", "-h"], ["--method", "--body"]);
  const opts = { method: "POST", body: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--method" && args[i + 1]) opts.method = args[++i];
    if (args[i] === "--body" && args[i + 1]) opts.body = args[++i];
  }
  const invokeOpts = { method: opts.method };
  if (opts.body !== undefined && opts.method !== "GET" && opts.method !== "HEAD") {
    invokeOpts.body = opts.body;
  }
  try {
    const result = await getSdk().functions.invoke(projectId, name, invokeOpts);
    const body = result.body;
    if (typeof body === "string") {
      process.stdout.write(body + "\n");
    } else {
      console.log(JSON.stringify(body, null, 2));
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function logs(projectId, name, args) {
  assertRequiredProjectAndName(projectId, name, "run402 functions logs <project_id> <name> [--tail <n>] [--request-id <req_...>]");
  assertKnownFlags(args, ["--tail", "--since", "--request-id", "--follow", "--help", "-h"], ["--tail", "--since", "--request-id"]);
  let tail = 50;
  let since = undefined;
  let requestId = undefined;
  let follow = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tail") tail = parseIntegerFlag("--tail", args[++i], { min: 1 });
    if (args[i] === "--since" && args[i + 1]) since = args[++i];
    if (args[i] === "--request-id" && args[i + 1]) requestId = args[++i];
    if (args[i] === "--follow") follow = true;
  }

  // Parse since: accept ISO string or epoch ms — keep CLI-side validation
  // so a bad `--since` errors with a clear message rather than silently
  // being dropped by the SDK.
  let sinceIso = undefined;
  if (since !== undefined) {
    const parsed = Number(since);
    const ms = Number.isNaN(parsed) ? new Date(since).getTime() : parsed;
    if (Number.isNaN(ms)) {
      fail({
        code: "BAD_USAGE",
        message: `Invalid --since value: ${since}`,
        details: { flag: "--since", value: since },
      });
    }
    sinceIso = new Date(ms).toISOString();
  }
  if (requestId !== undefined && !FUNCTION_LOG_REQUEST_ID_RE.test(requestId)) {
    fail({
      code: "BAD_USAGE",
      message: `Invalid --request-id value: ${requestId}`,
      details: { flag: "--request-id", value: requestId, expected: "req_<4-128 url-safe chars>" },
    });
  }

  const fetchLogs = async () => {
    try {
      const data = await getSdk().functions.logs(projectId, name, {
        tail,
        since: sinceIso,
        requestId,
      });
      return data.logs || [];
    } catch (err) {
      reportSdkError(err);
      return [];
    }
  };

  if (!follow) {
    const entries = await fetchLogs();
    console.log(JSON.stringify({ logs: entries }, null, 2));
    return;
  }

  // Follow mode: poll every 3s, print new entries.
  let running = true;
  process.on("SIGINT", () => { running = false; });

  let highWaterMs = sinceIso === undefined ? Number.NEGATIVE_INFINITY : new Date(sinceIso).getTime();
  let seenAtHighWater = new Set();

  const printFreshEntries = (entries) => {
    let nextHighWaterMs = highWaterMs;
    const fresh = [];
    for (const entry of entries) {
      const entryMs = logTimestampMs(entry);
      const identity = logEntryIdentity(entry);
      if (entryMs < highWaterMs) continue;
      if (entryMs === highWaterMs && seenAtHighWater.has(identity)) continue;
      fresh.push({ entry, entryMs, identity });
      if (entryMs > nextHighWaterMs) nextHighWaterMs = entryMs;
    }

    for (const { entry } of fresh) {
      console.log(`[${entry.timestamp}] ${entry.message}`);
    }
    if (fresh.length === 0 || !Number.isFinite(nextHighWaterMs)) return;

    const nextSeenAtHighWater = new Set();
    for (const entry of entries) {
      if (logTimestampMs(entry) === nextHighWaterMs) {
        nextSeenAtHighWater.add(logEntryIdentity(entry));
      }
    }
    for (const { entry, entryMs, identity } of fresh) {
      if (entryMs === nextHighWaterMs) {
        nextSeenAtHighWater.add(identity);
      }
    }
    highWaterMs = nextHighWaterMs;
    seenAtHighWater = nextSeenAtHighWater;
    sinceIso = new Date(highWaterMs).toISOString();
  };

  printFreshEntries(await fetchLogs());

  while (running) {
    await new Promise(r => setTimeout(r, 3000));
    if (!running) break;
    printFreshEntries(await fetchLogs());
  }
}

function logTimestampMs(entry) {
  const ms = new Date(entry.timestamp).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function logEntryIdentity(entry) {
  return entry.event_id || `${entry.log_stream_name || ""}:${entry.timestamp || ""}:${entry.message || ""}`;
}

async function update(projectId, name, args) {
  assertRequiredProjectAndName(projectId, name, "run402 functions update <project_id> <name> [options]");
  assertKnownFlags(args, ["--schedule", "--schedule-remove", "--timeout", "--memory", "--help", "-h"], ["--schedule", "--timeout", "--memory"]);
  let schedule = undefined;
  let scheduleRemove = false;
  let timeout = undefined;
  let memory = undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--schedule" && i + 1 < args.length) schedule = args[++i];
    if (args[i] === "--schedule-remove") scheduleRemove = true;
    if (args[i] === "--timeout") timeout = parseIntegerFlag("--timeout", args[++i], { min: 1 });
    if (args[i] === "--memory") memory = parseIntegerFlag("--memory", args[++i], { min: 1 });
  }

  const updateOpts = {};
  if (scheduleRemove || schedule === "") {
    updateOpts.schedule = null;
  } else if (schedule !== undefined) {
    updateOpts.schedule = schedule;
  }
  if (timeout !== undefined) updateOpts.timeout = timeout;
  if (memory !== undefined) updateOpts.memory = memory;

  if (Object.keys(updateOpts).length === 0) {
    fail({
      code: "BAD_USAGE",
      message: "Provide at least one of: --schedule, --schedule-remove, --timeout, --memory",
    });
  }

  try {
    const data = await getSdk().functions.update(projectId, name, updateOpts);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(projectId) {
  assertRequiredProject(projectId, "run402 functions list <project_id>");
  try {
    const data = await getSdk().functions.list(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteFunction(projectId, name) {
  assertRequiredProjectAndName(projectId, name, "run402 functions delete <project_id> <name>");
  try {
    await getSdk().functions.delete(projectId, name);
    console.log(JSON.stringify({ status: "ok", message: `Function '${name}' deleted.` }));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  args = normalizeArgv(args);
  if (Array.isArray(args) && hasHelp(args)) {
    console.log(SUB_HELP[sub] || HELP);
    process.exit(0);
  }
  switch (sub) {
    case "deploy": await deploy(args[0], args[1], args.slice(2)); break;
    case "invoke": await invoke(args[0], args[1], args.slice(2)); break;
    case "logs":   await logs(args[0], args[1], args.slice(2)); break;
    case "update": await update(args[0], args[1], args.slice(2)); break;
    case "list":   await list(args[0]); break;
    case "delete": await deleteFunction(args[0], args[1]); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

function assertRequiredProject(projectId, usage) {
  if (!projectId || String(projectId).startsWith("-")) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <project_id>.",
      hint: usage,
    });
  }
}

function assertRequiredProjectAndName(projectId, name, usage) {
  assertRequiredProject(projectId, usage);
  if (!name || String(name).startsWith("-")) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <name>.",
      hint: usage,
    });
  }
}
