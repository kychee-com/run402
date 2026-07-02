import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail, parseFlagJson } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, parseIntegerFlag, positionalArgs } from "./argparse.mjs";

// Extension → content-type for `--attach <path>` without an explicit `:type`.
const ATTACH_EXT_CONTENT_TYPES = {
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  zip: "application/zip",
  html: "text/html",
  xml: "application/xml",
};
const ATTACH_MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

function inferAttachmentContentType(path) {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  return ATTACH_EXT_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Parse repeatable `--attach <path>[:content-type]` flags into the SDK
 * attachment shape. The `:content-type` suffix is recognized only when the tail
 * after the last `:` looks like a MIME type, so paths containing a colon (e.g. a
 * Windows drive) are not mis-split.
 */
export function parseAttachments(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--attach") continue;
    const raw = args[++i];
    if (typeof raw !== "string" || raw.length === 0 || raw.startsWith("--")) {
      fail({ code: "BAD_USAGE", message: "--attach requires a <path>[:content-type] value" });
    }
    let path = raw;
    let contentType;
    const colon = raw.lastIndexOf(":");
    if (colon > 0 && ATTACH_MIME_RE.test(raw.slice(colon + 1))) {
      path = raw.slice(0, colon);
      contentType = raw.slice(colon + 1).toLowerCase();
    }
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch (err) {
      fail({
        code: "BAD_USAGE",
        message: `Cannot read attachment file: ${path}`,
        details: { error: String((err && err.message) || err) },
      });
    }
    out.push({
      filename: basename(path),
      content_base64: bytes.toString("base64"),
      content_type: contentType ?? inferAttachmentContentType(path),
    });
  }
  return out;
}

const HELP = `run402 email — Send emails from your project

Usage:
  run402 email <subcommand> [args...]

Subcommands:
  create <slug> [--project <id>]     Create a project-scoped mailbox local part
  mailboxes [--project <id>]         List mailboxes with default-role metadata
                                      and gateway next_actions
  defaults [--outbound <slug|id>] [--auth-sender <slug|id>] [--project <id>]
                                      Show or set mailbox defaults. With no
                                      flags, prints current settings/candidates.
  update [<slug|id>] --footer-policy <run402_transparency|none> [--project <id>]
                                      Update per-mailbox settings
  info   [--project <id>]            Show mailbox info, including footer policy
  status [--project <id>]            Alias for 'info' (prefer 'info')
  send   --to <email> [mode flags]   Send an email (template or raw HTML)
  list   [--limit <n>] [--after <cursor>] [--direction <inbound|outbound>] [--project <id>]
                                      List messages (paginated). Returns BOTH
                                      sent + received by default; --direction
                                      inbound is the reconciliation backstop.
  get    <message_id> [--project <id>]  Get a message with replies
  get-raw <message_id> --output <file> [--project <id>]
                                      Fetch raw RFC-822 bytes (inbound only).
                                      --output is required: bytes are written
                                      to the file; stdout receives a JSON
                                      envelope { message_id, bytes, output }.
  reply  <message_id> --html "..." [--text "..."] [--subject "..."] [--from-name "..."] [--project <id>]
                                      Reply to an inbound message (threads via In-Reply-To)
  delete [<slug|mailbox_id>] --confirm [--project <id>]
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
  webhooks deliveries [--status <s>] [--project <id>]
                                                  List durable delivery rows (DLQ visibility)
  webhooks redrive <delivery_id> [--project <id>]
                                                  Re-queue a dead-lettered delivery

Send modes:
  Template:  --template <name> --var key=value [--var ...]  OR --vars '{"k":"v",...}'
  Raw HTML:  --subject "..." --html "..." [--text "..."]    (both --subject and --html required)
  Raw HTML also supports: --attach <path>[:content-type] (repeatable; max 5, 7 MB total)
  Both modes support: --from-name "Display Name" --project <id>

Choosing a mailbox:
  --mailbox <slug|id>  Target a specific mailbox. Accepted by send, list, get,
                       get-raw, reply, info, update, and webhooks. For send,
                       omitting --mailbox uses default_outbound_mailbox_id when set; if
                       the gateway reports mailbox_settings and no default is
                       configured, set one with 'run402 email defaults'.
                       (delete takes the target as its positional
                       <slug|mailbox_id>.)

Templates:
  project_invite  — requires --var project_name=... --var invite_url=...
  magic_link      — requires --var project_name=... --var link_url=... --var expires_in=...
  notification    — requires --var project_name=... --var message=... (max 500 chars)

Examples:
  run402 email create my-app
  run402 email mailboxes
  run402 email defaults --outbound my-app --auth-sender my-app
  run402 email update my-app --footer-policy none
  run402 email send --template project_invite --to user@example.com \\
    --var project_name="My App" --var invite_url="https://example.com/invite/abc"
  run402 email send --to user@example.com --subject "Welcome!" \\
    --html "<h1>Hello</h1>" --from-name "My App"
  run402 email send --to user@example.com --subject "Your receipt" \\
    --html "<p>Attached.</p>" --attach ./receipt.pdf
  run402 email list --limit 50
  run402 email info
  run402 email get msg_abc123
  run402 email reply msg_abc123 --html "<p>Thanks!</p>"
  run402 email delete --confirm
  run402 email webhooks list
  run402 email webhooks register --url https://example.com/hook --events delivery,bounced

Notes:
  - Up to 5 mailboxes per project — configure explicit defaults before
    relying on omitted --mailbox sends
  - Footer policy: prototype is locked to run402_transparency; hobby/team can
    set none. Tier locks surface as FOOTER_POLICY_TIER_REQUIRED.
  - Single recipient per send (no CC/BCC)
  - Slug: 3-63 chars, lowercase alphanumeric + hyphens, no consecutive hyphens
  - --project defaults to the active project
`;

const SUB_HELP = {
  send: `run402 email send — Send an email (template or raw HTML)

Usage:
  run402 email send --to <email> --template <name> --var key=value [--var ...]
  run402 email send --to <email> --template <name> --vars '{"k":"v",...}'
  run402 email send --to <email> --subject "..." --html "..." [--text "..."] [--attach <path> ...]

Options:
  --to <email>        Recipient email address (required; single recipient)
  --template <name>   Template name (template mode): project_invite, magic_link,
                      notification
  --var key=value     Template variable (repeatable)
  --vars '<json>'     All template variables as a single JSON object
  --subject "..."     Subject line (raw HTML mode; required with --html)
  --html "..."        HTML body (raw HTML mode; required with --subject)
  --text "..."        Plain-text body (raw HTML mode; optional)
  --attach <path>[:content-type]  Attach a file (raw HTML mode only; repeatable;
                      max 5, ≤ 7 MB total). Content-type is inferred from the
                      extension when the :content-type suffix is omitted.
  --from-name "..."   Display name for the From header
  --mailbox <slug|id> Target mailbox. Omit to use default_outbound_mailbox_id.
  --project <id>      Project ID (defaults to the active project)
`,
  list: `run402 email list — List messages in the mailbox

Usage:
  run402 email list [--mailbox <slug|id>] [--limit <n>] [--after <cursor>] [--project <id>]
`,
  reply: `run402 email reply — Reply to an inbound message (threaded via In-Reply-To)

Usage:
  run402 email reply <message_id> --html "..." [--text "..."] [options]
`,
  delete: `run402 email delete — Delete the project's mailbox (irreversible)

Usage:
  run402 email delete [<slug|mailbox_id>] --confirm [--project <id>]
`,
  info: `run402 email info — Show mailbox info, including footer policy

Usage:
  run402 email info [--project <id>]
`,
  status: `run402 email status — Alias for 'run402 email info' (prefer 'info')

Usage:
  run402 email status [--project <id>]

See 'run402 email info --help' for details. 'status' is kept for backward
compatibility; new code should use 'info'.
`,
  "get-raw": `run402 email get-raw — Fetch raw RFC-822 bytes for an inbound message

Usage:
  run402 email get-raw <message_id> --output <file> [--project <id>]

Arguments:
  <message_id>        Inbound message ID

Options:
  --output <file>     Required: destination file for the raw RFC-822 bytes.
                      stdout receives a JSON envelope
                      { message_id, bytes, output } — the MIME body is never
                      written to stdout, so the CLI stays pipeable.
  --project <id>      Project ID (defaults to the active project)
  --mailbox <slug|id> Target a specific mailbox (required when the project
                      has more than one)
`,
  create: `run402 email create — Create a project mailbox

Usage:
  run402 email create <slug> [--project <id>]

Arguments:
  <slug>              Mailbox slug (3-63 chars, lowercase alphanumeric +
                      hyphens, no consecutive hyphens). The response's
                      managed_address is
                      <slug>@<project-mail-host>.mail.run402.com.

Options:
  --project <id>      Project ID (defaults to the active project)

Notes:
  - Up to 5 mailboxes per project; the same slug may be used by another project

Examples:
  run402 email create my-app
  run402 email create my-app --project prj_abc123
`,
  mailboxes: `run402 email mailboxes — List project mailboxes

Usage:
  run402 email mailboxes [--project <id>]

Returns JSON: { mailboxes, mailbox_settings?, next_actions? }. Mailbox rows
include default-role/readiness metadata when the gateway provides it.
`,
  defaults: `run402 email defaults — Show or set mailbox defaults

Usage:
  run402 email defaults [--project <id>]
  run402 email defaults --outbound <slug|mbx_id> [--auth-sender <slug|mbx_id>] [--project <id>]
  run402 email defaults --auth-sender <slug|mbx_id> [--project <id>]

Options:
  --outbound <slug|mbx_id>     Set default_outbound_mailbox_id
  --auth-sender <slug|mbx_id>  Set auth_sender_mailbox_id
  --clear-outbound             Clear default_outbound_mailbox_id
  --clear-auth-sender          Clear auth_sender_mailbox_id
  --project <id>               Project ID (defaults to the active project)
`,
  update: `run402 email update — Update per-mailbox settings

Usage:
  run402 email update [<slug|mbx_id>] --footer-policy <run402_transparency|none> [--project <id>]
  run402 email update --mailbox <slug|mbx_id> --footer-policy <run402_transparency|none> [--project <id>]

Options:
  --footer-policy <policy>  Outbound footer policy. Use run402_transparency or none.
                            Prototype projects are locked to run402_transparency;
                            attempts to set none return FOOTER_POLICY_TIER_REQUIRED.
  --mailbox <slug|id>       Target mailbox; omit only when the project has one mailbox.
  --project <id>            Project ID (defaults to the active project)
`,
  get: `run402 email get — Get a message with replies

Usage:
  run402 email get <message_id> [--mailbox <slug|id>] [--project <id>]

Arguments:
  <message_id>        Message ID to fetch

Options:
  --mailbox <slug|id> Target mailbox. Omit to use default_outbound_mailbox_id.
  --project <id>      Project ID (defaults to the active project)

Examples:
  run402 email get msg_abc123 --mailbox support
`,
};

function strictFlagValue(args, flag) {
  const value = flagValue(args, flag);
  if (typeof value === "string" && value.startsWith("--")) {
    fail({
      code: "BAD_FLAG",
      message: `${flag} requires a value`,
      details: { flag },
    });
  }
  return value;
}

function summarizeMailboxForDefaults(m) {
  return {
    mailbox_id: m.mailbox_id,
    slug: m.slug,
    address: m.address,
    managed_address: m.managed_address,
    status: m.status,
    is_default_outbound: m.is_default_outbound ?? false,
    is_auth_sender: m.is_auth_sender ?? false,
    can_send: m.can_send,
    can_receive: m.can_receive,
    send_blocked_reason: m.send_blocked_reason ?? null,
    domain_kind: m.domain_kind,
    address_domain: m.address_domain,
    managed_domain: m.managed_domain,
    custom_domain_ready: m.custom_domain_ready,
    footer_policy: m.footer_policy,
    effective_footer_policy: m.effective_footer_policy,
    footer_policy_locked_reason: m.footer_policy_locked_reason ?? null,
  };
}

function mailboxInfoPayload(m) {
  return {
    mailbox_id: m.mailbox_id,
    address: m.address,
    managed_address: m.managed_address,
    slug: m.slug,
    status: m.status,
    is_default_outbound: m.is_default_outbound,
    is_auth_sender: m.is_auth_sender,
    can_send: m.can_send,
    can_receive: m.can_receive,
    send_blocked_reason: m.send_blocked_reason,
    domain_kind: m.domain_kind,
    address_domain: m.address_domain,
    managed_domain: m.managed_domain,
    custom_domain_ready: m.custom_domain_ready,
    footer_policy: m.footer_policy,
    effective_footer_policy: m.effective_footer_policy,
    footer_policy_locked_reason: m.footer_policy_locked_reason,
  };
}

function mailboxIdFromSelector(envelope, selector, flag) {
  if (selector === undefined || selector === null) return undefined;
  if (/^mbx_/.test(selector)) return selector;
  const hit = (envelope.mailboxes ?? []).find((m) => m.mailbox_id === selector || m.slug === selector);
  if (!hit) {
    fail({
      code: "MAILBOX_NOT_FOUND",
      message: `No mailbox matching ${JSON.stringify(selector)} for ${flag}.`,
      details: {
        selector,
        flag,
        candidates: (envelope.mailboxes ?? []).map(summarizeMailboxForDefaults),
      },
      next_actions: [{ type: "list_mailboxes", command: "run402 email mailboxes" }],
    });
  }
  return hit.mailbox_id;
}

function validateArgs(args, knownFlags, flagsWithValues = knownFlags) {
  assertKnownFlags(args, knownFlags, flagsWithValues);
  const valueFlags = new Set(flagsWithValues);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!valueFlags.has(flag)) continue;
    if (i + 1 >= args.length || (typeof args[i + 1] === "string" && args[i + 1].startsWith("--"))) {
      fail({
        code: "BAD_FLAG",
        message: `${flag} requires a value`,
        details: { flag },
      });
    }
    i += 1;
  }
}

function parseVars(args) {
  const vars = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vars") {
      const raw = args[++i];
      const parsed = parseFlagJson("--vars", raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        fail({
          code: "BAD_USAGE",
          message: "--vars must be a JSON object, e.g. '{\"key\":\"value\"}'",
        });
      }
      for (const [k, v] of Object.entries(parsed)) vars[k] = typeof v === "string" ? v : String(v);
    }
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--var") {
      const raw = args[++i];
      const eq = raw.indexOf("=");
      if (eq > 0) vars[raw.slice(0, eq)] = raw.slice(eq + 1);
    }
  }
  return vars;
}

async function create(args) {
  validateArgs(args, ["--project"]);
  const slug = positionalArgs(args, ["--project"])[0] ?? null;
  const projectOpt = strictFlagValue(args, "--project");
  const projectId = resolveProjectId(projectOpt);
  if (!slug) {
    fail({
      code: "BAD_USAGE",
      message: "Missing slug.",
      hint: "run402 email create <slug>",
    });
  }

  try {
    const data = await getSdk().email.createMailbox(projectId, slug);
    console.log(JSON.stringify({
      mailbox_id: data.mailbox_id,
      address: data.address,
      managed_address: data.managed_address,
      slug: data.slug,
      status: data.status,
      domain_kind: data.domain_kind,
      address_domain: data.address_domain,
      managed_domain: data.managed_domain,
      custom_domain_ready: data.custom_domain_ready,
      can_receive: data.can_receive,
      footer_policy: data.footer_policy,
      effective_footer_policy: data.effective_footer_policy,
      footer_policy_locked_reason: data.footer_policy_locked_reason,
      mailbox_settings: data.mailbox_settings,
      next_actions: data.next_actions,
      created: true,
    }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function mailboxes(args) {
  validateArgs(args, ["--project"]);
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  try {
    const data = await getSdk().email.listMailboxes(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function defaults(args) {
  const knownFlags = ["--project", "--outbound", "--auth-sender", "--clear-outbound", "--clear-auth-sender"];
  const valueFlags = ["--project", "--outbound", "--auth-sender"];
  validateArgs(args, knownFlags, valueFlags);
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  const outbound = strictFlagValue(args, "--outbound");
  const authSender = strictFlagValue(args, "--auth-sender");
  const clearOutbound = args.includes("--clear-outbound");
  const clearAuthSender = args.includes("--clear-auth-sender");

  if (outbound && clearOutbound) {
    fail({ code: "BAD_USAGE", message: "Use either --outbound or --clear-outbound, not both." });
  }
  if (authSender && clearAuthSender) {
    fail({ code: "BAD_USAGE", message: "Use either --auth-sender or --clear-auth-sender, not both." });
  }

  const shouldPatch = outbound || authSender || clearOutbound || clearAuthSender;
  try {
    const current = await getSdk().email.listMailboxes(projectId);
    if (!shouldPatch) {
      console.log(JSON.stringify(current, null, 2));
      return;
    }

    const patch = {};
    if (outbound) patch.default_outbound_mailbox_id = mailboxIdFromSelector(current, outbound, "--outbound");
    if (clearOutbound) patch.default_outbound_mailbox_id = null;
    if (authSender) patch.auth_sender_mailbox_id = mailboxIdFromSelector(current, authSender, "--auth-sender");
    if (clearAuthSender) patch.auth_sender_mailbox_id = null;

    const updated = await getSdk().email.setMailboxDefaults(projectId, patch);
    console.log(JSON.stringify(updated, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function updateMailbox(args) {
  const valueFlags = ["--project", "--mailbox", "--footer-policy"];
  validateArgs(args, valueFlags);
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  const mailboxFlag = strictFlagValue(args, "--mailbox");
  const footerPolicy = strictFlagValue(args, "--footer-policy");
  const positional = positionalArgs(args, valueFlags);
  const target = positional[0] ?? null;

  if (positional.length > 1) {
    fail({
      code: "BAD_USAGE",
      message: "Too many positional arguments. Use one optional <slug|id> target.",
    });
  }
  if (target && mailboxFlag && target !== mailboxFlag) {
    fail({
      code: "BAD_USAGE",
      message: "Use either positional <slug|id> or --mailbox, not both.",
    });
  }
  if (!footerPolicy) {
    fail({
      code: "BAD_USAGE",
      message: "Missing --footer-policy <run402_transparency|none>.",
      hint: "run402 email update <slug|id> --footer-policy none",
    });
  }
  if (!["run402_transparency", "none"].includes(footerPolicy)) {
    fail({
      code: "BAD_USAGE",
      message: "--footer-policy must be one of: run402_transparency, none.",
      details: { footer_policy: footerPolicy },
    });
  }

  try {
    const data = await getSdk().email.updateMailbox(projectId, {
      mailbox: target ?? mailboxFlag ?? undefined,
      footer_policy: footerPolicy,
    });
    console.log(JSON.stringify(mailboxInfoPayload(data), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function send(args) {
  const valueFlags = ["--template", "--to", "--subject", "--html", "--text", "--from-name", "--project", "--vars", "--var", "--mailbox", "--attach"];
  validateArgs(args, valueFlags);
  const template = strictFlagValue(args, "--template");
  const to = strictFlagValue(args, "--to");
  const subject = strictFlagValue(args, "--subject");
  const html = strictFlagValue(args, "--html");
  const text = strictFlagValue(args, "--text");
  const fromName = strictFlagValue(args, "--from-name");
  const mailbox = strictFlagValue(args, "--mailbox");
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  const variables = parseVars(args);
  const attachments = parseAttachments(args);

  if (!to) {
    fail({ code: "BAD_USAGE", message: "Missing --to <email>" });
  }

  try {
    const data = await getSdk().email.send(projectId, {
      to,
      template: template ?? undefined,
      variables: template ? variables : undefined,
      subject: subject ?? undefined,
      html: html ?? undefined,
      text: text ?? undefined,
      from_name: fromName ?? undefined,
      mailbox: mailbox ?? undefined,
      attachments: attachments.length ? attachments : undefined,
    });
    console.log(JSON.stringify({
      message_id: data.message_id,
      to: data.to,
      template: data.template,
      subject: data.subject,
      status: data.status,
      sent_at: data.sent_at,
      mailbox_id: data.mailbox_id,
      from_address: data.from_address,
      sent: true,
    }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const valueFlags = ["--project", "--limit", "--after", "--mailbox", "--direction"];
  validateArgs(args, valueFlags);
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  const limit = strictFlagValue(args, "--limit");
  const after = strictFlagValue(args, "--after");
  const mailbox = strictFlagValue(args, "--mailbox");
  const direction = strictFlagValue(args, "--direction");
  try {
    const data = await getSdk().email.list(projectId, {
      limit: limit ? parseIntegerFlag("--limit", limit) : undefined,
      after: after ?? undefined,
      direction: direction ?? undefined,
      mailbox: mailbox ?? undefined,
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function get(args) {
  const valueFlags = ["--project", "--mailbox"];
  validateArgs(args, valueFlags);
  const messageId = positionalArgs(args, valueFlags)[0] ?? null;
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  const mailbox = strictFlagValue(args, "--mailbox");
  if (!messageId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing message_id.",
      hint: "run402 email get <message_id>",
    });
  }
  try {
    const data = await getSdk().email.get(projectId, messageId, { mailbox: mailbox ?? undefined });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function getRaw(args) {
  const valueFlags = ["--project", "--output", "--mailbox"];
  validateArgs(args, valueFlags);
  const messageId = positionalArgs(args, valueFlags)[0] ?? null;
  const outputFile = strictFlagValue(args, "--output");
  const mailbox = strictFlagValue(args, "--mailbox");
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  if (!messageId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing message_id.",
      hint: "run402 email get-raw <message_id> --output <file>",
    });
  }
  if (!outputFile) {
    fail({
      code: "BAD_USAGE",
      message: "Missing --output <file>. Raw MIME bytes must be written to a file, not stdout.",
      hint: "run402 email get-raw <message_id> --output <file>",
      details: { flag: "--output" },
    });
  }

  try {
    const result = await getSdk().email.getRaw(projectId, messageId, { mailbox: mailbox ?? undefined });
    const buf = Buffer.from(result.bytes);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outputFile, buf);
    console.log(JSON.stringify({ message_id: messageId, bytes: buf.length, output: outputFile }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function reply(args) {
  const valueFlags = ["--project", "--html", "--text", "--subject", "--from-name", "--mailbox"];
  validateArgs(args, valueFlags);
  const messageId = positionalArgs(args, valueFlags)[0] ?? null;
  const html = strictFlagValue(args, "--html");
  const text = strictFlagValue(args, "--text");
  const subjectOverride = strictFlagValue(args, "--subject");
  const fromName = strictFlagValue(args, "--from-name");
  const mailbox = strictFlagValue(args, "--mailbox");
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));

  if (!messageId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing message_id.",
      hint: 'run402 email reply <message_id> --html "..."',
    });
  }
  if (!html && !text) {
    fail({
      code: "BAD_USAGE",
      message: "Provide --html and/or --text for the reply body",
    });
  }

  try {
    // Fetch the original message to derive the reply-to address and subject.
    const original = await getSdk().email.get(projectId, messageId, { mailbox: mailbox ?? undefined });
    const replyTo = original.from || original.from_address || original.sender || null;
    if (!replyTo) {
      fail({
        code: "BAD_USAGE",
        message: "Original message has no from address to reply to",
        details: { original_keys: Object.keys(original) },
      });
    }
    const origSubject = typeof original.subject === "string" ? original.subject : "";
    const defaultSubject = origSubject && origSubject.toLowerCase().startsWith("re:")
      ? origSubject
      : `Re: ${origSubject || "(no subject)"}`;
    const replySubject = subjectOverride || defaultSubject;

    const data = await getSdk().email.send(projectId, {
      to: replyTo,
      subject: replySubject,
      html: html ?? undefined,
      text: text ?? undefined,
      from_name: fromName ?? undefined,
      in_reply_to: messageId,
      mailbox: mailbox ?? undefined,
    });
    console.log(JSON.stringify({ message_id: data.message_id, to: data.to, subject: replySubject, in_reply_to: messageId, sent: true }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteMailbox(args) {
  validateArgs(args, ["--project", "--confirm"], ["--project"]);
  const positional = positionalArgs(args, ["--project"])[0] ?? null;
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  const confirmed = args.includes("--confirm");

  if (!confirmed) {
    fail({
      code: "CONFIRMATION_REQUIRED",
      message: "Destructive: deleting a mailbox is irreversible (drops all messages and webhook subscriptions). Re-run with --confirm to proceed.",
    });
  }

  try {
    const data = await getSdk().email.deleteMailbox(projectId, positional ?? undefined);
    console.log(JSON.stringify({ mailbox_id: data.mailbox_id, address: data.address, deleted: true }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function status(args) {
  const valueFlags = ["--project", "--mailbox"];
  validateArgs(args, valueFlags);
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  const mailbox = strictFlagValue(args, "--mailbox");
  try {
    const mb = await getSdk().email.getMailbox(projectId, mailbox ?? undefined);
    console.log(JSON.stringify(mailboxInfoPayload(mb), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  args = normalizeArgv(args);
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h")) && sub !== "webhooks") { console.log(SUB_HELP[sub] || HELP); process.exit(0); }
  switch (sub) {
    case "create": await create(args); break;
    case "mailboxes": await mailboxes(args); break;
    case "defaults": await defaults(args); break;
    case "update": await updateMailbox(args); break;
    case "info":
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
      fail({ code: "UNKNOWN_SUBCOMMAND", message: `Unknown email subcommand: ${sub}`, hint: "Run `run402 email --help` for usage.", details: { command: "email", subcommand: sub } });
  }
}
