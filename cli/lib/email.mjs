import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail, parseFlagJson } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, parseIntegerFlag, positionalArgs } from "./argparse.mjs";

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
  run402 email send --to user@example.com --subject "Welcome!" \\
    --html "<h1>Hello</h1>" --from-name "My App"
  run402 email list --limit 50
  run402 email info
  run402 email get msg_abc123
  run402 email reply msg_abc123 --html "<p>Thanks!</p>"
  run402 email delete --confirm
  run402 email webhooks list
  run402 email webhooks register --url https://example.com/hook --events delivery,bounced

Notes:
  - One mailbox per project
  - Single recipient per send (no CC/BCC)
  - Slug: 3-63 chars, lowercase alphanumeric + hyphens, no consecutive hyphens
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
  --var key=value     Template variable (repeatable)
  --vars '<json>'     All template variables as a single JSON object
  --subject "..."     Subject line (raw HTML mode; required with --html)
  --html "..."        HTML body (raw HTML mode; required with --subject)
  --text "..."        Plain-text body (raw HTML mode; optional)
  --from-name "..."   Display name for the From header
  --project <id>      Project ID (defaults to the active project)
`,
  list: `run402 email list — List messages in the mailbox

Usage:
  run402 email list [--limit <n>] [--after <cursor>] [--project <id>]
`,
  reply: `run402 email reply — Reply to an inbound message (threaded via In-Reply-To)

Usage:
  run402 email reply <message_id> --html "..." [--text "..."] [options]
`,
  delete: `run402 email delete — Delete the project's mailbox (irreversible)

Usage:
  run402 email delete [<mailbox_id>] --confirm [--project <id>]
`,
  info: `run402 email info — Show mailbox info (ID, address, slug)

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
  run402 email get-raw <message_id> [--output <file>] [--project <id>]
`,
  create: `run402 email create — Create a project mailbox

Usage:
  run402 email create <slug> [--project <id>]

Arguments:
  <slug>              Mailbox slug (3-63 chars, lowercase alphanumeric +
                      hyphens, no consecutive hyphens). Becomes
                      <slug>@mail.run402.com.

Options:
  --project <id>      Project ID (defaults to the active project)

Notes:
  - One mailbox per project

Examples:
  run402 email create my-app
  run402 email create my-app --project prj_abc123
`,
  get: `run402 email get — Get a message with replies

Usage:
  run402 email get <message_id> [--project <id>]

Arguments:
  <message_id>        Message ID to fetch

Options:
  --project <id>      Project ID (defaults to the active project)

Examples:
  run402 email get msg_abc123
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
    console.log(JSON.stringify({ status: "ok", mailbox_id: data.mailbox_id, address: data.address, slug: data.slug }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function send(args) {
  const valueFlags = ["--template", "--to", "--subject", "--html", "--text", "--from-name", "--project", "--vars", "--var"];
  validateArgs(args, valueFlags);
  const template = strictFlagValue(args, "--template");
  const to = strictFlagValue(args, "--to");
  const subject = strictFlagValue(args, "--subject");
  const html = strictFlagValue(args, "--html");
  const text = strictFlagValue(args, "--text");
  const fromName = strictFlagValue(args, "--from-name");
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  const variables = parseVars(args);

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
    });
    console.log(JSON.stringify({ status: "ok", message_id: data.message_id, to: data.to, template: data.template, subject: data.subject }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const valueFlags = ["--project", "--limit", "--after"];
  validateArgs(args, valueFlags);
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  const limit = strictFlagValue(args, "--limit");
  const after = strictFlagValue(args, "--after");
  try {
    const data = await getSdk().email.list(projectId, {
      limit: limit ? parseIntegerFlag("--limit", limit) : undefined,
      after: after ?? undefined,
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function get(args) {
  validateArgs(args, ["--project"]);
  const messageId = positionalArgs(args, ["--project"])[0] ?? null;
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  if (!messageId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing message_id.",
      hint: "run402 email get <message_id>",
    });
  }
  try {
    const data = await getSdk().email.get(projectId, messageId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function getRaw(args) {
  const valueFlags = ["--project", "--output"];
  validateArgs(args, valueFlags);
  const messageId = positionalArgs(args, valueFlags)[0] ?? null;
  const outputFile = strictFlagValue(args, "--output");
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  if (!messageId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing message_id.",
      hint: "run402 email get-raw <message_id> [--output <file>]",
    });
  }

  try {
    const result = await getSdk().email.getRaw(projectId, messageId);
    const buf = Buffer.from(result.bytes);

    if (outputFile) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(outputFile, buf);
      console.log(JSON.stringify({ status: "ok", message_id: messageId, bytes: buf.length, output: outputFile }));
    } else {
      process.stdout.write(buf);
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function reply(args) {
  const valueFlags = ["--project", "--html", "--text", "--subject", "--from-name"];
  validateArgs(args, valueFlags);
  const messageId = positionalArgs(args, valueFlags)[0] ?? null;
  const html = strictFlagValue(args, "--html");
  const text = strictFlagValue(args, "--text");
  const subjectOverride = strictFlagValue(args, "--subject");
  const fromName = strictFlagValue(args, "--from-name");
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
    const original = await getSdk().email.get(projectId, messageId);
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
    });
    console.log(JSON.stringify({ status: "ok", message_id: data.message_id, to: data.to, subject: replySubject, in_reply_to: messageId }));
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
    console.log(JSON.stringify({ status: "ok", mailbox_id: data.mailbox_id, address: data.address, deleted: true }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function status(args) {
  validateArgs(args, ["--project"]);
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  try {
    const mb = await getSdk().email.getMailbox(projectId);
    console.log(JSON.stringify({ status: "ok", mailbox_id: mb.mailbox_id, address: mb.address, slug: mb.slug }));
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
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
