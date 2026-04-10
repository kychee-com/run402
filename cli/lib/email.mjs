import { findProject, resolveProjectId, API, updateProject, loadKeyStore, saveKeyStore } from "./config.mjs";

const HELP = `run402 email — Send emails from your project

Usage:
  run402 email <subcommand> [args...]

Subcommands:
  create <slug> [--project <id>]     Create a mailbox (<slug>@mail.run402.com)
  status [--project <id>]            Show mailbox info (ID, address, slug)
  send   --to <email> [mode flags]   Send an email (template or raw HTML)
  list   [--project <id>]            List sent emails
  get    <message_id> [--project <id>]  Get a message with replies
  get-raw <message_id> [--project <id>] [--output <file>]
                                         Fetch raw RFC-822 bytes (inbound only)

Send modes:
  Template:  --template <name> --var key=value [--var ...]
  Raw HTML:  --subject "..." --html "..." [--text "..."]
  Both modes support: --from-name "Display Name" --project <id>

Templates:
  project_invite  — requires --var project_name=... --var invite_url=...
  magic_link      — requires --var project_name=... --var link_url=... --var expires_in=...
  notification    — requires --var project_name=... --var message=... (max 500 chars)

Examples:
  run402 email create my-app
  run402 email send --template project_invite --to user@example.com \\
    --var project_name="My App" --var invite_url="https://example.com/invite/abc"
  run402 email send --to user@example.com --subject "Welcome!" \\
    --html "<h1>Hello</h1><p>Welcome aboard.</p>" --from-name "My App"
  run402 email send --template notification --to admin@example.com \\
    --var project_name="My App" --var message="Deploy complete"
  run402 email list
  run402 email get msg_abc123
  run402 email get-raw msg_abc123 --output reply.eml

Notes:
  - One mailbox per project
  - Single recipient per send (no CC/BCC)
  - Slug: 3-63 chars, lowercase alphanumeric + hyphens, no consecutive hyphens
  - Rate limits vary by tier (prototype: 10/day, hobby: 50/day, team: 500/day)
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

async function create(args) {
  let slug = null;
  let projectOpt = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) { projectOpt = args[++i]; }
    else if (!args[i].startsWith("--") && !slug) { slug = args[i]; }
  }
  const projectId = resolveProjectId(projectOpt);
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
    // On 409 (mailbox already exists), discover existing mailbox and return it
    if (res.status === 409) {
      const mbId = await resolveMailboxId(projectId, p.service_key).catch(() => null);
      if (mbId) {
        const store = loadKeyStore();
        const proj = store.projects[projectId];
        console.log(JSON.stringify({ status: "ok", mailbox_id: mbId, address: proj?.mailbox_address || mbId, already_existed: true }));
        return;
      }
    }
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }

  updateProject(projectId, { mailbox_id: data.mailbox_id, mailbox_address: data.address });
  console.log(JSON.stringify({ status: "ok", mailbox_id: data.mailbox_id, address: data.address, slug: data.slug }));
}

async function send(args) {
  const template = parseFlag(args, "--template");
  const to = parseFlag(args, "--to");
  const subject = parseFlag(args, "--subject");
  const html = parseFlag(args, "--html");
  const text = parseFlag(args, "--text");
  const fromName = parseFlag(args, "--from-name");
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  const p = findProject(projectId);
  const variables = parseVars(args);

  if (!to) {
    console.error(JSON.stringify({ status: "error", message: "Missing --to <email>" }));
    process.exit(1);
  }

  const isRaw = !!(subject || html);
  const isTemplate = !!template;
  if (!isRaw && !isTemplate) {
    console.error(JSON.stringify({ status: "error", message: "Provide --template (template mode) or --subject + --html (raw HTML mode)" }));
    process.exit(1);
  }

  const mailboxId = await requireMailboxId(projectId, p.service_key);

  const body = { to };
  if (isTemplate) {
    body.template = template;
    body.variables = variables;
  } else {
    body.subject = subject;
    body.html = html;
    if (text) body.text = text;
  }
  if (fromName) body.from_name = fromName;

  const res = await fetch(`${API}/mailboxes/v1/${mailboxId}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }

  console.log(JSON.stringify({ status: "ok", message_id: data.id, to: data.to, template: data.template || null, subject: data.subject || null }));
}

async function list(args) {
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  const p = findProject(projectId);
  const mailboxId = await requireMailboxId(projectId, p.service_key);

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
  let messageId = null;
  let projectOpt = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) { projectOpt = args[++i]; }
    else if (!args[i].startsWith("--") && !messageId) { messageId = args[i]; }
  }
  const projectId = resolveProjectId(projectOpt);
  const p = findProject(projectId);

  if (!messageId) {
    console.error(JSON.stringify({ status: "error", message: "Missing message_id. Usage: run402 email get <message_id>" }));
    process.exit(1);
  }

  const mailboxId = await requireMailboxId(projectId, p.service_key);

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

async function getRaw(args) {
  let messageId = null;
  let projectOpt = null;
  let outputFile = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) { projectOpt = args[++i]; }
    else if (args[i] === "--output" && args[i + 1]) { outputFile = args[++i]; }
    else if (!args[i].startsWith("--") && !messageId) { messageId = args[i]; }
  }
  const projectId = resolveProjectId(projectOpt);
  const p = findProject(projectId);

  if (!messageId) {
    console.error(JSON.stringify({ status: "error", message: "Missing message_id. Usage: run402 email get-raw <message_id> [--output <file>]" }));
    process.exit(1);
  }

  const mailboxId = await requireMailboxId(projectId, p.service_key);

  const res = await fetch(`${API}/mailboxes/v1/${mailboxId}/messages/${messageId}/raw`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  if (!res.ok) {
    let errBody;
    try { errBody = await res.json(); } catch { errBody = { error: await res.text().catch(() => "Unknown error") }; }
    console.error(JSON.stringify({ status: "error", http: res.status, ...errBody }));
    process.exit(1);
  }

  const buf = Buffer.from(await res.arrayBuffer());

  if (outputFile) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outputFile, buf);
    console.log(JSON.stringify({ status: "ok", message_id: messageId, bytes: buf.length, output: outputFile }));
  } else {
    // Write raw bytes to stdout (no JSON wrapping — binary pipe-friendly)
    process.stdout.write(buf);
  }
}

async function status(args) {
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  const p = findProject(projectId);

  const res = await fetch(`${API}/mailboxes/v1`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }
  const body = await res.json();
  const mailboxes = body.mailboxes || body;
  if (!Array.isArray(mailboxes) || mailboxes.length === 0) {
    console.error(JSON.stringify({ status: "error", message: "No mailbox found. Run: run402 email create <slug>" }));
    process.exit(1);
  }
  const mb = mailboxes[0];
  updateProject(projectId, { mailbox_id: mb.mailbox_id, mailbox_address: mb.address });
  console.log(JSON.stringify({ status: "ok", mailbox_id: mb.mailbox_id, address: mb.address, slug: mb.slug }));
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  switch (sub) {
    case "create": await create(args); break;
    case "status": await status(args); break;
    case "send":   await send(args); break;
    case "list":   await list(args); break;
    case "get":    await get(args); break;
    case "get-raw": await getRaw(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
