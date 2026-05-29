import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs, validateWebhookUrl } from "./argparse.mjs";

const HELP = `run402 email webhooks — Manage mailbox webhooks

Usage:
  run402 email webhooks <action> [args...]

Actions:
  list       [--mailbox <slug|id>] [--project <id>]            List webhooks
  get        <webhook_id> [--mailbox <slug|id>] [--project <id>]   Get a webhook
  delete     <webhook_id> [--mailbox <slug|id>] [--project <id>]   Delete a webhook
  update     <webhook_id> [--url <url>] [--events <e1,e2>] [--mailbox <slug|id>]  Update a webhook
  register   --url <url> --events <e1,e2> [--mailbox <slug|id>] [--project <id>]  Register a new webhook
  deliveries [--status <s>] [--mailbox <slug|id>] [--project <id>]  List durable delivery rows (DLQ visibility)
  redrive    <delivery_id> [--mailbox <slug|id>] [--project <id>]   Re-queue a dead-lettered delivery

Valid events: delivery, bounced, complained, reply_received
Delivery statuses: pending, in_flight, delivered, failed_permanent (the DLQ)

Webhook delivery is durable + at-least-once: failures retry with backoff, then
land in failed_permanent (the dead-letter queue). The delivered body is the
canonical envelope { id, type, created_at, schema_version, idempotency_key,
payload } — consumers MUST dedupe on idempotency_key. Use 'deliveries' to
inspect what was lost and 'redrive' to replay a dead-lettered delivery.

Pass --mailbox <slug|id> to target a specific mailbox when the project has more than one.

Examples:
  run402 email webhooks list
  run402 email webhooks register --url https://example.com/hook --events delivery,bounced
  run402 email webhooks update whk_123 --url https://new.example.com/hook
  run402 email webhooks delete whk_123
  run402 email webhooks deliveries --status failed_permanent
  run402 email webhooks redrive wd_123
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

async function list(args) {
  const valueFlags = ["--project", "--mailbox"];
  validateArgs(args, valueFlags);
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  const mailbox = strictFlagValue(args, "--mailbox");
  try {
    const data = await getSdk().email.webhooks.list(projectId, { mailbox: mailbox ?? undefined });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function get(args) {
  const valueFlags = ["--project", "--mailbox"];
  validateArgs(args, valueFlags);
  const webhookId = positionalArgs(args, valueFlags)[0] ?? null;
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  const mailbox = strictFlagValue(args, "--mailbox");
  if (!webhookId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing webhook_id.",
      hint: "run402 email webhooks get <webhook_id>",
    });
  }
  try {
    const data = await getSdk().email.webhooks.get(projectId, webhookId, { mailbox: mailbox ?? undefined });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function del(args) {
  const valueFlags = ["--project", "--mailbox"];
  validateArgs(args, valueFlags);
  const webhookId = positionalArgs(args, valueFlags)[0] ?? null;
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  const mailbox = strictFlagValue(args, "--mailbox");
  if (!webhookId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing webhook_id.",
      hint: "run402 email webhooks delete <webhook_id>",
    });
  }
  try {
    await getSdk().email.webhooks.delete(projectId, webhookId, { mailbox: mailbox ?? undefined });
    console.log(JSON.stringify({ webhook_id: webhookId, project_id: projectId, deleted: true }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function update(args) {
  const valueFlags = ["--project", "--url", "--events", "--mailbox"];
  validateArgs(args, valueFlags);
  const webhookId = positionalArgs(args, valueFlags)[0] ?? null;
  const url = strictFlagValue(args, "--url");
  const eventsRaw = strictFlagValue(args, "--events");
  const mailbox = strictFlagValue(args, "--mailbox");
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  if (!webhookId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing webhook_id.",
      hint: "run402 email webhooks update <webhook_id> [--url <url>] [--events <e1,e2>]",
    });
  }
  if (!url && !eventsRaw) {
    fail({ code: "BAD_USAGE", message: "Provide at least --url or --events" });
  }
  // GH-192: scheme-only local validation. Server-side SSRF defenses are out
  // of scope for the CLI (private-IP / DNS rebinding / IMDS belongs on the
  // gateway). `validateWebhookUrl` is a no-op when `url` is null/undefined,
  // so partial updates that change only `--events` still work.
  validateWebhookUrl(url, "--url");

  try {
    const data = await getSdk().email.webhooks.update(projectId, webhookId, {
      url: url ?? undefined,
      events: eventsRaw ? eventsRaw.split(",").map((e) => e.trim()) : undefined,
      mailbox: mailbox ?? undefined,
    });
    console.log(JSON.stringify(data));
  } catch (err) {
    reportSdkError(err);
  }
}

async function register(args) {
  const valueFlags = ["--project", "--url", "--events", "--mailbox"];
  validateArgs(args, valueFlags);
  const url = strictFlagValue(args, "--url");
  const eventsRaw = strictFlagValue(args, "--events");
  const mailbox = strictFlagValue(args, "--mailbox");
  const projectOpt = strictFlagValue(args, "--project");
  const projectId = resolveProjectId(projectOpt);

  if (!url) {
    fail({
      code: "BAD_USAGE",
      message: "Missing --url.",
      hint: "run402 email webhooks register --url <url> --events <e1,e2>",
    });
  }
  // GH-192: validate scheme locally before any network call. Catches
  // javascript:/file:/http:/data: schemes that the gateway would reject
  // anyway, but with a friendlier round-trip-free error.
  validateWebhookUrl(url, "--url");
  if (!eventsRaw) {
    fail({
      code: "BAD_USAGE",
      message: "Missing --events.",
      hint: "Valid events: delivery, bounced, complained, reply_received",
    });
  }

  const events = eventsRaw.split(",").map((e) => e.trim());
  try {
    const data = await getSdk().email.webhooks.register(projectId, { url, events, mailbox: mailbox ?? undefined });
    console.log(JSON.stringify(data));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deliveries(args) {
  const valueFlags = ["--project", "--mailbox", "--status", "--limit", "--after"];
  validateArgs(args, valueFlags);
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  const mailbox = strictFlagValue(args, "--mailbox");
  const status = strictFlagValue(args, "--status");
  const limitRaw = strictFlagValue(args, "--limit");
  const after = strictFlagValue(args, "--after");
  try {
    const data = await getSdk().email.webhooks.listDeliveries(projectId, {
      status: status ?? undefined,
      limit: limitRaw ? Number(limitRaw) : undefined,
      after: after ?? undefined,
      mailbox: mailbox ?? undefined,
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function redrive(args) {
  const valueFlags = ["--project", "--mailbox"];
  validateArgs(args, valueFlags);
  const deliveryId = positionalArgs(args, valueFlags)[0] ?? null;
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  const mailbox = strictFlagValue(args, "--mailbox");
  if (!deliveryId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing delivery_id.",
      hint: "run402 email webhooks redrive <delivery_id>",
    });
  }
  try {
    const data = await getSdk().email.webhooks.redriveDelivery(projectId, deliveryId, { mailbox: mailbox ?? undefined });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  args = normalizeArgv(args);
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) { console.log(SUB_HELP[sub] || HELP); process.exit(0); }
  switch (sub) {
    case "list":       await list(args); break;
    case "get":        await get(args); break;
    case "delete":     await del(args); break;
    case "update":     await update(args); break;
    case "register":   await register(args); break;
    case "deliveries": await deliveries(args); break;
    case "redrive":    await redrive(args); break;
    default:
      console.error(`Unknown webhooks action: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
