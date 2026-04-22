import { findProject, resolveProjectId, API, updateProject, loadKeyStore, saveKeyStore } from "./config.mjs";

const HELP = `run402 email — Send emails from your project

Usage:
  run402 email <subcommand> [args...]

Subcommands:
  create <slug> [--project <id>]     Create a mailbox (<slug>@mail.run402.com)
  info   [--project <id>]            Show mailbox info (ID, address, slug)
  status [--project <id>]            Alias for 'info' (prefer 'info')
  send   --to <email> [mode flags]   Send an email (template or raw HTML)
  list   [--limit <n>] [--after <cursor>] [--project <id>]
                                      List sent/received messages (paginated)
  get    <message_id> [--project <id>]  Get a message with replies
  get-raw <message_id> [--project <id>] [--output <file>]
                                      Fetch raw RFC-822 bytes (inbound only)
  reply  <message_id> --html "..." [--text "..."] [--subject "..."] [--from-name "..."] [--project <id>]
                                      Reply to an inbound message (threads via In-Reply-To)
  delete [<mailbox_id>] --confirm [--project <id>]
                                      Delete the project's mailbox (irreversible)
  webhooks <action> [args...]        Manage webhooks (see below)

Webhook subcommands:
  webhooks list   [--project <id>]                List webhooks
  webhooks get    <webhook_id> [--project <id>]   Get a webhook
  webhooks delete <webhook_id> [--project <id>]   Delete a webhook
  webhooks update <webhook_id> [--url <url>] [--events <e1,e2>] [--project <id>]
                                                  Update a webhook
  webhooks register --url <url> --events <e1,e2> [--project <id>]
                                                  Register a new webhook

Send modes:
  Template:  --template <name> --var key=value [--var ...]  OR --vars '{"k":"v",...}'
  Raw HTML:  --subject "..." --html "..." [--text "..."]    (both --subject and --html required)
  Both modes support: --from-name "Display Name" --project <id>

Templates:
  project_invite  — requires --var project_name=... --var invite_url=...
  magic_link      — requires --var project_name=... --var link_url=... --var expires_in=...
  notification    — requires --var project_name=... --var message=... (max 500 chars)

Examples:
  run402 email create my-app
  run402 email send --template project_invite --to user@example.com \\
    --var project_name="My App" --var invite_url="https://example.com/invite/abc"
  run402 email send --template project_invite --to user@example.com \\
    --vars '{"project_name":"My App","invite_url":"https://example.com/invite/abc"}'
  run402 email send --to user@example.com --subject "Welcome!" \\
    --html "<h1>Hello</h1><p>Welcome aboard.</p>" --from-name "My App"
  run402 email send --template notification --to admin@example.com \\
    --var project_name="My App" --var message="Deploy complete"
  run402 email list --limit 50
  run402 email list --limit 50 --after msg_abc123
  run402 email info
  run402 email get msg_abc123
  run402 email get-raw msg_abc123 --output reply.eml
  run402 email reply msg_abc123 --html "<p>Thanks!</p>"
  run402 email delete --confirm
  run402 email webhooks list
  run402 email webhooks register --url https://example.com/hook --events delivery,bounced

Notes:
  - One mailbox per project
  - Single recipient per send (no CC/BCC)
  - Slug: 3-63 chars, lowercase alphanumeric + hyphens, no consecutive hyphens
  - Rate limits vary by tier (prototype: 10/day, hobby: 50/day, team: 500/day)
  - --project defaults to the active project
`;

const SUB_HELP = {
  send: `run402 email send — Send an email (template or raw HTML)

Usage:
  run402 email send --to <email> --template <name> --var key=value [--var ...]
  run402 email send --to <email> --template <name> --vars '{"k":"v",...}'
  run402 email send --to <email> --subject "..." --html "..." [--text "..."]

Options:
  --to <email>        Recipient email address (required; single recipient)
  --template <name>   Template name (template mode): project_invite, magic_link,
                      notification
  --var key=value     Template variable (repeatable; required keys vary by
                      template)
  --vars '<json>'     All template variables as a single JSON object
                      (alternative to multiple --var). Later --var overrides.
  --subject "..."     Subject line (raw HTML mode; required with --html)
  --html "..."        HTML body (raw HTML mode; required with --subject)
  --text "..."        Plain-text body (raw HTML mode; optional)
  --from-name "..."   Display name for the From header
  --project <id>      Project ID (defaults to the active project)

Templates:
  project_invite      project_name, invite_url
  magic_link          project_name, link_url, expires_in
  notification        project_name, message (max 500 chars)

Examples:
  run402 email send --template project_invite --to user@example.com \\
    --var project_name="My App" --var invite_url="https://example.com/invite/abc"
  run402 email send --template project_invite --to user@example.com \\
    --vars '{"project_name":"My App","invite_url":"https://example.com/invite/abc"}'
  run402 email send --to user@example.com --subject "Welcome!" \\
    --html "<h1>Hello</h1><p>Welcome aboard.</p>" --from-name "My App"
`,
  list: `run402 email list — List messages in the mailbox

Usage:
  run402 email list [--limit <n>] [--after <cursor>] [--project <id>]

Options:
  --limit <n>         Max messages to return (server caps at 200)
  --after <cursor>    Pagination cursor (message id from prior page)
  --project <id>      Project ID (defaults to the active project)

Examples:
  run402 email list
  run402 email list --limit 50
  run402 email list --limit 50 --after msg_abc123
`,
  reply: `run402 email reply — Reply to an inbound message (threaded via In-Reply-To)

Usage:
  run402 email reply <message_id> --html "..." [--text "..."] [options]

Arguments:
  <message_id>        Inbound message ID to reply to

Options:
  --html "..."        HTML reply body (required unless --text is given)
  --text "..."        Plain-text reply body (required unless --html is given)
  --subject "..."     Override the reply subject (default: "Re: <original>")
  --from-name "..."   Display name for the From header
  --project <id>      Project ID (defaults to the active project)

Notes:
  The CLI fetches the original message to derive the reply-to address and
  subject, then POSTs a new message with in_reply_to = <message_id> so the
  server can wire the RFC-822 In-Reply-To / References headers.

Examples:
  run402 email reply msg_abc123 --html "<p>Thanks, here's the info you asked for.</p>"
  run402 email reply msg_abc123 --subject "Re: invoice #42" --text "Paid, thanks."
`,
  delete: `run402 email delete — Delete the project's mailbox (irreversible)

Usage:
  run402 email delete [<mailbox_id>] --confirm [--project <id>]

Arguments:
  <mailbox_id>        Mailbox ID to delete (defaults to the project's mailbox)

Options:
  --confirm           Required: explicit confirmation flag
  --project <id>      Project ID (defaults to the active project)

Notes:
  Destructive. Drops all messages and webhook subscriptions. Cached
  mailbox_id in the local keystore is cleared on success.

Examples:
  run402 email delete --confirm
  run402 email delete mbx_abc123 --confirm
`,
  info: `run402 email info — Show mailbox info (ID, address, slug)

Usage:
  run402 email info [--project <id>]

Options:
  --project <id>      Project ID (defaults to the active project)

Notes:
  Same output as 'run402 email status' (kept as an alias for backward
  compatibility). 'info' is the preferred name.
`,
  status: `run402 email status — Alias for 'run402 email info' (prefer 'info')

Usage:
  run402 email status [--project <id>]

See 'run402 email info --help' for details. 'status' is kept for backward
compatibility; new code should use 'info'.
`,
  "get-raw": `run402 email get-raw — Fetch raw RFC-822 bytes for an inbound message

Usage:
  run402 email get-raw <message_id> [--output <file>] [--project <id>]

Arguments:
  <message_id>        Message ID to fetch (inbound messages only)

Options:
  --output <file>     Write raw bytes to this file; omit to stream to stdout
  --project <id>      Project ID (defaults to the active project)

Examples:
  run402 email get-raw msg_abc123 --output reply.eml
  run402 email get-raw msg_abc123 > reply.eml
`,
};

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function parseFlag(args, flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) return args[i + 1];
  }
  return null;
}

function parseVars(args) {
  const vars = {};
  // Apply --vars '<json>' first so later --var can override on key collision.
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vars" && args[i + 1]) {
      const raw = args[++i];
      let parsed;
      try { parsed = JSON.parse(raw); } catch {
        console.error(JSON.stringify({ status: "error", message: "Invalid JSON for --vars. Expected a JSON object, e.g. '{\"key\":\"value\"}'" }));
        process.exit(1);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        console.error(JSON.stringify({ status: "error", message: "--vars must be a JSON object, e.g. '{\"key\":\"value\"}'" }));
        process.exit(1);
      }
      for (const [k, v] of Object.entries(parsed)) vars[k] = typeof v === "string" ? v : String(v);
    }
  }
  // Then --var key=value (later wins).
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

  const hasSubject = !!subject;
  const hasHtml = !!html;
  const isRaw = hasSubject || hasHtml;
  const isTemplate = !!template;
  if (!isRaw && !isTemplate) {
    console.error(JSON.stringify({ status: "error", message: "Provide --template (template mode) or both --subject and --html (raw HTML mode)" }));
    process.exit(1);
  }
  if (isRaw && isTemplate) {
    console.error(JSON.stringify({ status: "error", message: "Provide --template OR raw mode (--subject + --html), not both" }));
    process.exit(1);
  }
  if (isRaw && !(hasSubject && hasHtml)) {
    const missing = hasSubject ? "--html" : "--subject";
    console.error(JSON.stringify({ status: "error", message: `Raw mode requires both --subject and --html (missing ${missing})` }));
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
  const limit = parseFlag(args, "--limit");
  const after = parseFlag(args, "--after");
  const mailboxId = await requireMailboxId(projectId, p.service_key);

  const qs = new URLSearchParams();
  if (limit) qs.set("limit", limit);
  if (after) qs.set("after", after);
  const url = `${API}/mailboxes/v1/${mailboxId}/messages${qs.toString() ? "?" + qs.toString() : ""}`;

  const res = await fetch(url, {
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

async function reply(args) {
  let messageId = null;
  let projectOpt = null;
  let outputFile = null;
  void outputFile;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--project" && args[i + 1]) { projectOpt = args[++i]; }
    else if (a === "--html" || a === "--text" || a === "--subject" || a === "--from-name") { i++; }
    else if (!a.startsWith("--") && !messageId) { messageId = a; }
  }
  const html = parseFlag(args, "--html");
  const text = parseFlag(args, "--text");
  const subjectOverride = parseFlag(args, "--subject");
  const fromName = parseFlag(args, "--from-name");
  const projectId = resolveProjectId(projectOpt);
  const p = findProject(projectId);

  if (!messageId) {
    console.error(JSON.stringify({ status: "error", message: "Missing message_id. Usage: run402 email reply <message_id> --html \"...\"" }));
    process.exit(1);
  }
  if (!html && !text) {
    console.error(JSON.stringify({ status: "error", message: "Provide --html and/or --text for the reply body" }));
    process.exit(1);
  }

  const mailboxId = await requireMailboxId(projectId, p.service_key);

  const getRes = await fetch(`${API}/mailboxes/v1/${mailboxId}/messages/${messageId}`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const original = await getRes.json().catch(() => ({}));
  if (!getRes.ok) {
    console.error(JSON.stringify({ status: "error", http: getRes.status, message: "Failed to fetch original message", ...original }));
    process.exit(1);
  }

  const replyTo = original.from || original.from_address || original.sender || null;
  if (!replyTo) {
    console.error(JSON.stringify({ status: "error", message: "Original message has no from address to reply to", original_keys: Object.keys(original) }));
    process.exit(1);
  }
  const origSubject = typeof original.subject === "string" ? original.subject : "";
  const defaultSubject = origSubject && origSubject.toLowerCase().startsWith("re:")
    ? origSubject
    : `Re: ${origSubject || "(no subject)"}`;
  const replySubject = subjectOverride || defaultSubject;

  const body = { to: replyTo, subject: replySubject, in_reply_to: messageId };
  if (html) body.html = html;
  if (text) body.text = text;
  if (fromName) body.from_name = fromName;

  const res = await fetch(`${API}/mailboxes/v1/${mailboxId}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }

  console.log(JSON.stringify({ status: "ok", message_id: data.id, to: data.to, subject: replySubject, in_reply_to: messageId }));
}

async function deleteMailbox(args) {
  let positional = null;
  let projectOpt = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--project" && args[i + 1]) { projectOpt = args[++i]; }
    else if (a === "--confirm") { /* flag */ }
    else if (!a.startsWith("--") && !positional) { positional = a; }
  }
  const projectId = resolveProjectId(projectOpt);
  const p = findProject(projectId);
  const confirmed = args.includes("--confirm");

  if (!confirmed) {
    console.error(JSON.stringify({
      status: "error",
      message: "Destructive: deleting a mailbox is irreversible (drops all messages and webhook subscriptions). Re-run with --confirm to proceed.",
    }));
    process.exit(1);
  }

  const mailboxId = positional || await requireMailboxId(projectId, p.service_key);

  const res = await fetch(`${API}/mailboxes/v1/${mailboxId}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  if (res.status !== 204 && !res.ok) {
    let errBody;
    try { errBody = await res.json(); } catch { errBody = {}; }
    console.error(JSON.stringify({ status: "error", http: res.status, ...errBody }));
    process.exit(1);
  }

  // Clear the cached mailbox_id/address from the local keystore so future
  // email commands re-discover (or fail-fast with "no mailbox found").
  const store = loadKeyStore();
  const proj = store.projects[projectId];
  if (proj) {
    delete proj.mailbox_id;
    delete proj.mailbox_address;
    saveKeyStore(store);
  }

  console.log(JSON.stringify({ status: "ok", mailbox_id: mailboxId, deleted: true }));
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
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h")) && sub !== "webhooks") { console.log(SUB_HELP[sub] || HELP); process.exit(0); }
  switch (sub) {
    case "create": await create(args); break;
    case "info":   // fall through — 'info' is the preferred name; 'status' is a backward-compat alias
    case "status": await status(args); break;
    case "send":   await send(args); break;
    case "list":   await list(args); break;
    case "get":    await get(args); break;
    case "get-raw": await getRaw(args); break;
    case "reply":  await reply(args); break;
    case "delete": await deleteMailbox(args); break;
    case "webhooks": {
      const { run: runWebhooks } = await import("./webhooks.mjs");
      await runWebhooks(args[0], args.slice(1));
      break;
    }
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
