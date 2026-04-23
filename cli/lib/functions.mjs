import { readFileSync } from "fs";
import { findProject, API } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";

const HELP = `run402 functions — Manage serverless functions

Usage:
  run402 functions <subcommand> [args...]

Subcommands:
  deploy <id> <name> --file <file> [--timeout <s>] [--memory <mb>] [--deps <pkg,...>] [--schedule <cron>]
                                       Deploy a function to a project
  invoke <id> <name> [--method <M>] [--body <json>]
                                       Invoke a deployed function
  logs   <id> <name> [--tail <n>] [--since <ts>] [--follow]
                                       Get function logs
  update <id> <name> [--schedule <cron>] [--schedule-remove] [--timeout <s>] [--memory <mb>]
                                       Update function schedule or config without re-deploying
  list   <id>                          List all functions for a project
  delete <id> <name>                   Delete a function

Examples:
  run402 functions deploy abc123 stripe-webhook --file handler.ts
  run402 functions deploy abc123 send-reminders --file remind.ts --schedule '*/15 * * * *'
  run402 functions deploy abc123 send-reminders --file remind.ts --schedule ''   # remove schedule
  run402 functions invoke abc123 stripe-webhook --body '{"event":"test"}'
  run402 functions logs abc123 stripe-webhook --tail 100
  run402 functions logs abc123 stripe-webhook --since 2026-03-29T14:00:00Z
  run402 functions logs abc123 stripe-webhook --follow
  run402 functions update abc123 send-reminders --schedule '0 */4 * * *'
  run402 functions update abc123 send-reminders --schedule-remove
  run402 functions update abc123 my-func --timeout 15 --memory 256
  run402 functions list abc123
  run402 functions delete abc123 stripe-webhook

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
  --deps <pkg,...>    Comma-separated npm deps to bundle
  --schedule <cron>   Cron schedule; pass '' to clear an existing schedule

Notes:
  Code must export a default async function:
    export default async (req: Request) => Response
  Deploy may require payment if the project lease has expired.

Examples:
  run402 functions deploy abc123 stripe-webhook --file handler.ts
  run402 functions deploy abc123 send-reminders --file remind.ts \\
    --schedule '*/15 * * * *'
  run402 functions deploy abc123 send-reminders --file remind.ts --schedule ''
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
  run402 functions invoke abc123 stripe-webhook --body '{"event":"test"}'
  run402 functions invoke abc123 ping --method GET
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
  --follow            Poll every 3s and stream new entries (Ctrl-C to stop)

Examples:
  run402 functions logs abc123 stripe-webhook --tail 100
  run402 functions logs abc123 stripe-webhook --since 2026-03-29T14:00:00Z
  run402 functions logs abc123 stripe-webhook --follow
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
  run402 functions update abc123 send-reminders --schedule '0 */4 * * *'
  run402 functions update abc123 send-reminders --schedule-remove
  run402 functions update abc123 my-func --timeout 15 --memory 256
`,
};

async function deploy(projectId, name, args) {
  const opts = { file: null, timeout: undefined, memory: undefined, deps: undefined, schedule: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) opts.file = args[++i];
    if (args[i] === "--timeout" && args[i + 1]) opts.timeout = parseInt(args[++i]);
    if (args[i] === "--memory" && args[i + 1]) opts.memory = parseInt(args[++i]);
    if (args[i] === "--deps" && args[i + 1]) opts.deps = args[++i].split(",");
    if (args[i] === "--schedule" && i + 1 < args.length) opts.schedule = args[++i];
  }
  if (!opts.file) { console.error(JSON.stringify({ status: "error", message: "Missing --file <file>" })); process.exit(1); }
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
  let tail = 50;
  let since = undefined;
  let follow = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tail" && args[i + 1]) tail = parseInt(args[++i]);
    if (args[i] === "--since" && args[i + 1]) since = args[++i];
    if (args[i] === "--follow") follow = true;
  }

  // Parse since: accept ISO string or epoch ms — keep CLI-side validation
  // so a bad `--since` errors with a clear message rather than silently
  // being dropped by the SDK.
  let sinceIso = undefined;
  if (since !== undefined) {
    const parsed = Number(since);
    const ms = Number.isNaN(parsed) ? new Date(since).getTime() : parsed;
    if (Number.isNaN(ms)) { console.error(JSON.stringify({ status: "error", message: `Invalid --since value: ${since}` })); process.exit(1); }
    sinceIso = new Date(ms).toISOString();
  }

  const fetchLogs = async () => {
    try {
      const data = await getSdk().functions.logs(projectId, name, {
        tail,
        since: sinceIso,
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

  const initial = await fetchLogs();
  for (const entry of initial) {
    console.log(`[${entry.timestamp}] ${entry.message}`);
  }
  if (initial.length > 0) {
    sinceIso = new Date(new Date(initial[initial.length - 1].timestamp).getTime() + 1).toISOString();
  }

  while (running) {
    await new Promise(r => setTimeout(r, 3000));
    if (!running) break;
    const entries = await fetchLogs();
    for (const entry of entries) {
      console.log(`[${entry.timestamp}] ${entry.message}`);
    }
    if (entries.length > 0) {
      sinceIso = new Date(new Date(entries[entries.length - 1].timestamp).getTime() + 1).toISOString();
    }
  }
}

async function update(projectId, name, args) {
  let schedule = undefined;
  let scheduleRemove = false;
  let timeout = undefined;
  let memory = undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--schedule" && i + 1 < args.length) schedule = args[++i];
    if (args[i] === "--schedule-remove") scheduleRemove = true;
    if (args[i] === "--timeout" && args[i + 1]) timeout = parseInt(args[++i]);
    if (args[i] === "--memory" && args[i + 1]) memory = parseInt(args[++i]);
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
    console.error(JSON.stringify({ status: "error", message: "Provide at least one of: --schedule, --schedule-remove, --timeout, --memory" }));
    process.exit(1);
  }

  try {
    const data = await getSdk().functions.update(projectId, name, updateOpts);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(projectId) {
  try {
    const data = await getSdk().functions.list(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteFunction(projectId, name) {
  try {
    await getSdk().functions.delete(projectId, name);
    console.log(JSON.stringify({ status: "ok", message: `Function '${name}' deleted.` }));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
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
