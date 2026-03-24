import { findProject, resolveProjectId, API, updateProject, loadKeyStore, saveKeyStore } from "./config.mjs";

const HELP = `run402 email — Send template-based emails from your project

Usage:
  run402 email <subcommand> [args...]

Subcommands:
  create <slug> [--project <id>]     Create a mailbox (<slug>@mail.run402.com)
  send   --template <name> --to <email> [--var key=value ...] [--project <id>]
                                     Send a template email
  list   [--project <id>]            List sent emails
  get    <message_id> [--project <id>]  Get a message with replies

Templates:
  project_invite  — requires --var project_name=... --var invite_url=...
  magic_link      — requires --var project_name=... --var link_url=... --var expires_in=...
  notification    — requires --var project_name=... --var message=... (max 500 chars)

Examples:
  run402 email create my-app
  run402 email send --template project_invite --to user@example.com \\
    --var project_name="My App" --var invite_url="https://example.com/invite/abc"
  run402 email send --template notification --to admin@example.com \\
    --var project_name="My App" --var message="Deploy complete"
  run402 email list
  run402 email get msg_abc123

Notes:
  - One mailbox per project
  - Single recipient per send (no CC/BCC)
  - Slug: 3-63 chars, lowercase alphanumeric + hyphens, no consecutive hyphens
  - Rate limits vary by tier (prototype: 10/day, hobby: 50/day, team: 200/day)
  - --project defaults to the active project
`;

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function parseFlag(args, flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) return args[i + 1];
  }
  return null;
}

function parseVars(args) {
  const vars = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--var" && args[i + 1]) {
      const raw = args[++i];
      const eq = raw.indexOf("=");
      if (eq > 0) {
        vars[raw.slice(0, eq)] = raw.slice(eq + 1);
      }
    }
  }
  return vars;
}

async function resolveMailboxId(projectId, serviceKey) {
  const store = loadKeyStore();
  const proj = store.projects[projectId];
  if (proj && proj.mailbox_id) return proj.mailbox_id;

  // Fallback: discover via API
  const res = await fetch(`${API}/mailboxes/v1`, {
    headers: { "Authorization": `Bearer ${serviceKey}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }
  const mailboxes = await res.json();
  if (!Array.isArray(mailboxes) || mailboxes.length === 0) {
    console.error(JSON.stringify({ status: "error", message: "No mailbox found. Run: run402 email create <slug>" }));
    process.exit(1);
  }
  const mb = mailboxes[0];
  updateProject(projectId, { mailbox_id: mb.id, mailbox_address: mb.address });
  return mb.id;
}

async function create(args) {
  const slug = args.find(a => !a.startsWith("--"));
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  const p = findProject(projectId);

  if (!slug) {
    console.error(JSON.stringify({ status: "error", message: "Missing slug. Usage: run402 email create <slug>" }));
    process.exit(1);
  }
  if (slug.length < 3 || slug.length > 63) {
    console.error(JSON.stringify({ status: "error", message: "Slug must be 3-63 characters." }));
    process.exit(1);
  }
  if (!SLUG_RE.test(slug)) {
    console.error(JSON.stringify({ status: "error", message: "Slug must be lowercase alphanumeric + hyphens, start/end with alphanumeric." }));
    process.exit(1);
  }
  if (slug.includes("--")) {
    console.error(JSON.stringify({ status: "error", message: "Slug must not contain consecutive hyphens." }));
    process.exit(1);
  }

  const res = await fetch(`${API}/mailboxes/v1`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ slug, project_id: projectId }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }

  updateProject(projectId, { mailbox_id: data.id, mailbox_address: data.address });
  console.log(JSON.stringify({ status: "ok", mailbox_id: data.id, address: data.address, slug: data.slug }));
}

async function send(args) {
  const template = parseFlag(args, "--template");
  const to = parseFlag(args, "--to");
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  const p = findProject(projectId);
  const variables = parseVars(args);

  if (!template) {
    console.error(JSON.stringify({ status: "error", message: "Missing --template. Options: project_invite, magic_link, notification" }));
    process.exit(1);
  }
  if (!to) {
    console.error(JSON.stringify({ status: "error", message: "Missing --to <email>" }));
    process.exit(1);
  }

  const mailboxId = await resolveMailboxId(projectId, p.service_key);

  const res = await fetch(`${API}/mailboxes/v1/${mailboxId}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ template, to, variables }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }

  console.log(JSON.stringify({ status: "ok", message_id: data.id, to: data.to, template: data.template }));
}

async function list(args) {
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  const p = findProject(projectId);
  const mailboxId = await resolveMailboxId(projectId, p.service_key);

  const res = await fetch(`${API}/mailboxes/v1/${mailboxId}/messages`, {
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
  const messageId = args.find(a => !a.startsWith("--"));
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  const p = findProject(projectId);

  if (!messageId) {
    console.error(JSON.stringify({ status: "error", message: "Missing message_id. Usage: run402 email get <message_id>" }));
    process.exit(1);
  }

  const mailboxId = await resolveMailboxId(projectId, p.service_key);

  const res = await fetch(`${API}/mailboxes/v1/${mailboxId}/messages/${messageId}`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }

  console.log(JSON.stringify(data, null, 2));
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  switch (sub) {
    case "create": await create(args); break;
    case "send":   await send(args); break;
    case "list":   await list(args); break;
    case "get":    await get(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
