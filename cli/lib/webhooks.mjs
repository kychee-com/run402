import { findProject, resolveProjectId, API, loadKeyStore, updateProject } from "./config.mjs";

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

function parseFlag(args, flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) return args[i + 1];
  }
  return null;
}

async function resolveMailboxId(projectId, serviceKey) {
  const store = loadKeyStore();
  const proj = store.projects[projectId];
  if (proj && proj.mailbox_id) return proj.mailbox_id;

  const res = await fetch(`${API}/mailboxes/v1`, {
    headers: { "Authorization": `Bearer ${serviceKey}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error("Failed to resolve mailbox"), { http: res.status, ...data });
  }
  const body = await res.json();
  const mailboxes = body.mailboxes || body;
  if (!Array.isArray(mailboxes) || mailboxes.length === 0) {
    throw new Error("No mailbox found. Run: run402 email create <slug>");
  }
  const mb = mailboxes[0];
  updateProject(projectId, { mailbox_id: mb.mailbox_id, mailbox_address: mb.address });
  return mb.mailbox_id;
}

async function requireMailboxId(projectId, serviceKey) {
  try {
    return await resolveMailboxId(projectId, serviceKey);
  } catch (err) {
    const out = { status: "error", message: err.message };
    if (err.http) out.http = err.http;
    console.error(JSON.stringify(out));
    process.exit(1);
  }
}

async function list(args) {
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  const p = findProject(projectId);
  const mailboxId = await requireMailboxId(projectId, p.service_key);

  const res = await fetch(`${API}/mailboxes/v1/${mailboxId}/webhooks`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }
  console.log(JSON.stringify(data, null, 2));
}

async function get(args) {
  let webhookId = null;
  let projectOpt = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) { projectOpt = args[++i]; }
    else if (!args[i].startsWith("--") && !webhookId) { webhookId = args[i]; }
  }
  const projectId = resolveProjectId(projectOpt);
  const p = findProject(projectId);

  if (!webhookId) {
    console.error(JSON.stringify({ status: "error", message: "Missing webhook_id. Usage: run402 email webhooks get <webhook_id>" }));
    process.exit(1);
  }

  const mailboxId = await requireMailboxId(projectId, p.service_key);
  const res = await fetch(`${API}/mailboxes/v1/${mailboxId}/webhooks/${webhookId}`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }
  console.log(JSON.stringify(data, null, 2));
}

async function del(args) {
  let webhookId = null;
  let projectOpt = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) { projectOpt = args[++i]; }
    else if (!args[i].startsWith("--") && !webhookId) { webhookId = args[i]; }
  }
  const projectId = resolveProjectId(projectOpt);
  const p = findProject(projectId);

  if (!webhookId) {
    console.error(JSON.stringify({ status: "error", message: "Missing webhook_id. Usage: run402 email webhooks delete <webhook_id>" }));
    process.exit(1);
  }

  const mailboxId = await requireMailboxId(projectId, p.service_key);
  const res = await fetch(`${API}/mailboxes/v1/${mailboxId}/webhooks/${webhookId}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  if (!res.ok) {
    let errBody;
    try { errBody = await res.json(); } catch { errBody = {}; }
    console.error(JSON.stringify({ status: "error", http: res.status, ...errBody }));
    process.exit(1);
  }
  console.log(JSON.stringify({ status: "ok", webhook_id: webhookId, deleted: true }));
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
  const p = findProject(projectId);

  if (!webhookId) {
    console.error(JSON.stringify({ status: "error", message: "Missing webhook_id. Usage: run402 email webhooks update <webhook_id> [--url <url>] [--events <e1,e2>]" }));
    process.exit(1);
  }
  if (!url && !eventsRaw) {
    console.error(JSON.stringify({ status: "error", message: "Provide at least --url or --events" }));
    process.exit(1);
  }

  const body = {};
  if (url) body.url = url;
  if (eventsRaw) body.events = eventsRaw.split(",").map(e => e.trim());

  const mailboxId = await requireMailboxId(projectId, p.service_key);
  const res = await fetch(`${API}/mailboxes/v1/${mailboxId}/webhooks/${webhookId}`, {
    method: "PATCH",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }
  console.log(JSON.stringify({ status: "ok", ...data }));
}

async function register(args) {
  const url = parseFlag(args, "--url");
  const eventsRaw = parseFlag(args, "--events");
  const projectOpt = parseFlag(args, "--project");
  const projectId = resolveProjectId(projectOpt);
  const p = findProject(projectId);

  if (!url) {
    console.error(JSON.stringify({ status: "error", message: "Missing --url. Usage: run402 email webhooks register --url <url> --events <e1,e2>" }));
    process.exit(1);
  }
  if (!eventsRaw) {
    console.error(JSON.stringify({ status: "error", message: "Missing --events. Valid events: delivery, bounced, complained, reply_received" }));
    process.exit(1);
  }

  const events = eventsRaw.split(",").map(e => e.trim());
  const mailboxId = await requireMailboxId(projectId, p.service_key);
  const res = await fetch(`${API}/mailboxes/v1/${mailboxId}/webhooks`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, events }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }
  console.log(JSON.stringify({ status: "ok", ...data }));
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
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
