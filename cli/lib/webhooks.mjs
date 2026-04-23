import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";

const HELP = `run402 email webhooks — Manage mailbox webhooks

Usage:
  run402 email webhooks <action> [args...]

Actions:
  list     [--project <id>]                                  List webhooks
  get      <webhook_id> [--project <id>]                     Get a webhook
  delete   <webhook_id> [--project <id>]                     Delete a webhook
  update   <webhook_id> [--url <url>] [--events <e1,e2>]     Update a webhook
  register --url <url> --events <e1,e2> [--project <id>]     Register a new webhook

Valid events: delivery, bounced, complained, reply_received

Examples:
  run402 email webhooks list
  run402 email webhooks register --url https://example.com/hook --events delivery,bounced
  run402 email webhooks update whk_123 --url https://new.example.com/hook
  run402 email webhooks delete whk_123
`;

const SUB_HELP = {
  update: `run402 email webhooks update — Update an existing webhook

Usage:
  run402 email webhooks update <webhook_id> [--url <url>] [--events <e1,e2>] [--project <id>]
`,
  register: `run402 email webhooks register — Register a new webhook

Usage:
  run402 email webhooks register --url <url> --events <e1,e2> [--project <id>]
`,
};

function parseFlag(args, flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) return args[i + 1];
  }
  return null;
}

async function list(args) {
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  try {
    const data = await getSdk().email.webhooks.list(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function get(args) {
  let webhookId = null;
  let projectOpt = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) { projectOpt = args[++i]; }
    else if (!args[i].startsWith("--") && !webhookId) { webhookId = args[i]; }
  }
  const projectId = resolveProjectId(projectOpt);
  if (!webhookId) {
    console.error(JSON.stringify({ status: "error", message: "Missing webhook_id. Usage: run402 email webhooks get <webhook_id>" }));
    process.exit(1);
  }
  try {
    const data = await getSdk().email.webhooks.get(projectId, webhookId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function del(args) {
  let webhookId = null;
  let projectOpt = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) { projectOpt = args[++i]; }
    else if (!args[i].startsWith("--") && !webhookId) { webhookId = args[i]; }
  }
  const projectId = resolveProjectId(projectOpt);
  if (!webhookId) {
    console.error(JSON.stringify({ status: "error", message: "Missing webhook_id. Usage: run402 email webhooks delete <webhook_id>" }));
    process.exit(1);
  }
  try {
    await getSdk().email.webhooks.delete(projectId, webhookId);
    console.log(JSON.stringify({ status: "ok", webhook_id: webhookId, deleted: true }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function update(args) {
  let webhookId = null;
  let projectOpt = null;
  const url = parseFlag(args, "--url");
  const eventsRaw = parseFlag(args, "--events");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) { projectOpt = args[++i]; }
    else if (args[i] === "--url" || args[i] === "--events") { i++; }
    else if (!args[i].startsWith("--") && !webhookId) { webhookId = args[i]; }
  }
  const projectId = resolveProjectId(projectOpt);
  if (!webhookId) {
    console.error(JSON.stringify({ status: "error", message: "Missing webhook_id. Usage: run402 email webhooks update <webhook_id> [--url <url>] [--events <e1,e2>]" }));
    process.exit(1);
  }
  if (!url && !eventsRaw) {
    console.error(JSON.stringify({ status: "error", message: "Provide at least --url or --events" }));
    process.exit(1);
  }

  try {
    const data = await getSdk().email.webhooks.update(projectId, webhookId, {
      url: url ?? undefined,
      events: eventsRaw ? eventsRaw.split(",").map((e) => e.trim()) : undefined,
    });
    console.log(JSON.stringify({ status: "ok", ...data }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function register(args) {
  const url = parseFlag(args, "--url");
  const eventsRaw = parseFlag(args, "--events");
  const projectOpt = parseFlag(args, "--project");
  const projectId = resolveProjectId(projectOpt);

  if (!url) {
    console.error(JSON.stringify({ status: "error", message: "Missing --url. Usage: run402 email webhooks register --url <url> --events <e1,e2>" }));
    process.exit(1);
  }
  if (!eventsRaw) {
    console.error(JSON.stringify({ status: "error", message: "Missing --events. Valid events: delivery, bounced, complained, reply_received" }));
    process.exit(1);
  }

  const events = eventsRaw.split(",").map((e) => e.trim());
  try {
    const data = await getSdk().email.webhooks.register(projectId, { url, events });
    console.log(JSON.stringify({ status: "ok", ...data }));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) { console.log(SUB_HELP[sub] || HELP); process.exit(0); }
  switch (sub) {
    case "list":     await list(args); break;
    case "get":      await get(args); break;
    case "delete":   await del(args); break;
    case "update":   await update(args); break;
    case "register": await register(args); break;
    default:
      console.error(`Unknown webhooks action: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
