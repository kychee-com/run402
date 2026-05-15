import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs, validateWebhookUrl } from "./argparse.mjs";

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
  validateArgs(args, ["--project"]);
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  try {
    const data = await getSdk().email.webhooks.list(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function get(args) {
  validateArgs(args, ["--project"]);
  const webhookId = positionalArgs(args, ["--project"])[0] ?? null;
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  if (!webhookId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing webhook_id.",
      hint: "run402 email webhooks get <webhook_id>",
    });
  }
  try {
    const data = await getSdk().email.webhooks.get(projectId, webhookId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function del(args) {
  validateArgs(args, ["--project"]);
  const webhookId = positionalArgs(args, ["--project"])[0] ?? null;
  const projectId = resolveProjectId(strictFlagValue(args, "--project"));
  if (!webhookId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing webhook_id.",
      hint: "run402 email webhooks delete <webhook_id>",
    });
  }
  try {
    await getSdk().email.webhooks.delete(projectId, webhookId);
    console.log(JSON.stringify({ status: "ok", webhook_id: webhookId, deleted: true }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function update(args) {
  const valueFlags = ["--project", "--url", "--events"];
  validateArgs(args, valueFlags);
  const webhookId = positionalArgs(args, valueFlags)[0] ?? null;
  const url = strictFlagValue(args, "--url");
  const eventsRaw = strictFlagValue(args, "--events");
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
    });
    console.log(JSON.stringify({ status: "ok", ...data }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function register(args) {
  const valueFlags = ["--project", "--url", "--events"];
  validateArgs(args, valueFlags);
  const url = strictFlagValue(args, "--url");
  const eventsRaw = strictFlagValue(args, "--events");
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
    const data = await getSdk().email.webhooks.register(projectId, { url, events });
    console.log(JSON.stringify({ status: "ok", ...data }));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  args = normalizeArgv(args);
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
