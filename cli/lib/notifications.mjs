/**
 * run402 notifications — Operator health notifications + Telegram channel/rules.
 *
 * Wraps the v1.55 `add-operator-health-notifications` API surface:
 *
 *   - run402 notifications list [--type ...] [--since ...] [--limit N] [--after <cursor>]
 *   - run402 notifications get <id>
 *   - run402 notifications preferences [get|set ...]
 *   - run402 notifications test [--source app|platform] [--type <event_type>]
 *   - run402 webhook-secret rotate
 *
 * ...and the `notification-channel-routing-telegram` cascade (self-serve
 * Telegram push + per-rule routing on top of the substrate above):
 *
 *   - run402 notifications channels connect telegram [--label <name>]
 *   - run402 notifications channels list
 *   - run402 notifications channels revoke <binding_id>
 *   - run402 notifications rules add --binding <id> [--project <id>] [--source app|platform] [--type a,b] [--class a,b]
 *   - run402 notifications rules list
 *   - run402 notifications rules rm <rule_id>
 *
 * All commands use the allowance-wallet auth path (SIWX). The assurance
 * ladder is enforced server-side; CLI surfaces 403/412/503 errors verbatim
 * (message + code + next_actions) via reportSdkError — no client-side
 * special-casing needed, e.g. a not-yet-provisioned Telegram bot surfaces as
 * 503 TELEGRAM_CHANNEL_NOT_CONFIGURED with its next_actions intact.
 *
 * `channels`/`rules` are nested groups dispatched via `if (sub === ...)`
 * (not `case`), mirroring cli/lib/org.mjs's `member`/`invite` groups — see
 * sync.test.ts's parseNotificationsGroupActions for why.
 */

import { allowanceAuthHeaders } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import {
  assertAllowedValue,
  assertKnownFlags,
  flagValue,
  normalizeArgv,
  positionalArgs,
  requirePositionalCount,
} from "./argparse.mjs";

const HELP = `run402 notifications — Operator health notifications + Telegram channel/rules

Usage:
  run402 notifications list [--type <event_type>] [--since <iso>] [--limit N] [--after <cursor>]
  run402 notifications get <id>
  run402 notifications preferences
  run402 notifications preferences set <key>=<value> [<key>=<value> ...]
  run402 notifications test [--source app|platform] [--type <event_type>]
  run402 notifications channels connect telegram [--label <name>]
  run402 notifications channels list
  run402 notifications channels revoke <binding_id>
  run402 notifications rules add --binding <binding_id> [--project <id>] [--source app|platform] [--type a,b] [--class a,b]
  run402 notifications rules list
  run402 notifications rules rm <rule_id>

Examples:
  run402 notifications list --limit 10
  run402 notifications list --type project_past_due --since 2026-05-01T00:00:00Z
  run402 notifications get 9b21fa0a-...
  run402 notifications preferences
  run402 notifications preferences set digest_cadence=weekly digest_day_of_week=1
  run402 notifications preferences set webhook_url=https://my-receiver.example.com/hook
  run402 notifications test
  run402 notifications test --source app --type signature_failed
  run402 notifications channels connect telegram --label "kychon alerts"
  run402 notifications channels list
  run402 notifications rules add --binding bnd_1 --project prj_abc --source app --type signature_failed

Auth ladder (enforced server-side):
  - SIWX wallet:      read own notifications + preferences
  - email_verified:   cross-wallet rollup reads + multi-wallet preference updates
  - operator_passkey: webhook URL changes, webhook secret rotation, Telegram
                       channel connect/revoke, routing rule add/rm (channel
                       connect additionally requires a VERIFIED operator email)

Telegram channels + routing rules teach their own rule model in detail via
'run402 notifications channels --help' / 'run402 notifications rules --help'
(AND'd match dimensions, wildcards, one rule -> one chat, no rules -> no
Telegram traffic).
`;

const CHANNELS_HELP = `run402 notifications channels — Telegram channel bindings

Usage:
  run402 notifications channels connect telegram [--label <name>]
  run402 notifications channels list
  run402 notifications channels revoke <binding_id>

connect telegram:
  Creates a PENDING binding and prints two single-use, 15-minute deep links:
  a private-chat link and a group-chat link. Open ONE of them in Telegram and
  tap Start — whichever is tapped first consumes the code. This command then
  POLLS 'channels list' (every few seconds, printing progress to stderr)
  until the binding flips to active, or the code expires, whichever happens
  first. Requires operator_passkey assurance AND a VERIFIED operator email
  (bindings are addressed to it — see 'run402 agent verify-email').

  --label <name>   Human-readable name for the chat (e.g. "kychon alerts"),
                   1-64 characters.

list:
  Shows every notification channel — email, webhook, and every live
  (non-revoked) Telegram binding — for the authenticated wallet.

revoke <binding_id>:
  Revokes a Telegram binding. Requires operator_passkey assurance. A
  missing / already-revoked / another operator's binding id all return the
  same not-found error (no existence oracle).

Until the platform's dedicated Telegram bot is provisioned on this
deployment, 'connect telegram' returns 503 TELEGRAM_CHANNEL_NOT_CONFIGURED
with a next_actions entry pointing at the operator to finish setup.

Examples:
  run402 notifications channels connect telegram
  run402 notifications channels connect telegram --label "kychon alerts"
  run402 notifications channels list
  run402 notifications channels revoke bnd_1a2b3c
`;

const RULES_HELP = `run402 notifications rules — Telegram routing rules

Usage:
  run402 notifications rules add --binding <binding_id> [--project <id>] [--source app|platform] [--type a,b] [--class a,b]
  run402 notifications rules list
  run402 notifications rules rm <rule_id>

The rule model:
  - One rule routes to exactly ONE Telegram binding (one chat) — "N
    destinations" is N rules, never a fan-out list on a single rule.
  - Every match dimension you set is ANDed: --project + --source + --type +
    --class must ALL match an event for the rule to fire.
  - An OMITTED dimension is a WILDCARD (matches anything for that
    dimension). 'rules add --binding bnd_1' with no other flags matches
    EVERY event routed to that operator.
  - --type and --class accept comma-separated lists and match if the event
    is ANY of the listed values, e.g.
    --type signature_failed,signature_expired.
  - --source is "app" (your deployed function's events.emit(...) calls from
    @run402/functions) or "platform" (deploys, lifecycle, verification,
    ...). Omit it to match both.
  - Multiple rules OR together across an event; if two of YOUR rules both
    resolve to the SAME binding for one event, only one message is sent
    (deduped per chat, not per rule).
  - NO RULES = NO TELEGRAM TRAFFIC for that operator. The Telegram channel
    is opt-in per event, per rule — there is no "send everything" default,
    unlike the always-on email channel.
  - Rules govern the Telegram channel ONLY (v1). The mandatory email floor
    (security / recovery / billing_critical / destructive_lifecycle /
    verification classes) is completely untouched by this command and can
    NEVER be silenced by adding or omitting a rule.

Requires operator_passkey assurance for add/rm. 'rules add' rejects an
unusable telegram_binding_id (revoked / not yours / nonexistent) with the
same 404 either way (authorize-before-reveal) — run 'channels list' first to
confirm the binding is 'active'.

Examples:
  run402 notifications rules add --binding bnd_1
  run402 notifications rules add --binding bnd_1 --project prj_abc --source app --type signature_failed
  run402 notifications rules add --binding bnd_1 --class security,recovery
  run402 notifications rules list
  run402 notifications rules rm rule_9b21fa0a
`;

// ---------------------------------------------------------------------------
// Operator health notifications (v1.55) — list / get / preferences / test.
// ---------------------------------------------------------------------------

async function list(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--type", "--since", "--limit", "--after"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for notifications list: ${extra[0]}` });
  }
  allowanceAuthHeaders("/agent/v1/notifications");
  const opts = {};
  const type = flagValue(parsedArgs, "--type");
  const since = flagValue(parsedArgs, "--since");
  const limit = flagValue(parsedArgs, "--limit");
  const after = flagValue(parsedArgs, "--after");
  if (type) opts.type = type;
  if (since) opts.since = since;
  if (limit != null) opts.limit = Number(limit);
  if (after != null) opts.after = after;
  try {
    const data = await getSdk().admin.listNotifications(opts);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function get(args) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const positionals = positionalArgs(parsedArgs);
  if (positionals.length !== 1) {
    fail({ code: "BAD_USAGE", message: "Usage: run402 notifications get <id>" });
  }
  allowanceAuthHeaders("/agent/v1/notifications");
  try {
    const data = await getSdk().admin.getNotification(positionals[0]);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function preferences(args) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const positionals = positionalArgs(parsedArgs);
  allowanceAuthHeaders("/agent/v1/notifications/preferences");

  if (positionals.length === 0) {
    // GET preferences
    try {
      const data = await getSdk().admin.getNotificationPreferences();
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  if (positionals[0] !== "set") {
    fail({ code: "BAD_USAGE", message: "Usage: run402 notifications preferences [set <key>=<value> ...]" });
  }

  // SET — parse remaining positional args as key=value
  const patch = {};
  for (const kv of positionals.slice(1)) {
    const eq = kv.indexOf("=");
    if (eq <= 0) {
      fail({ code: "BAD_USAGE", message: `Expected key=value, got: ${kv}` });
    }
    const key = kv.slice(0, eq);
    const rawValue = kv.slice(eq + 1);
    if (key === "digest_day_of_week" || key === "digest_hour_utc") {
      patch[key] = Number(rawValue);
    } else if (key === "webhook_url" && (rawValue === "null" || rawValue === "")) {
      patch[key] = null;
    } else {
      patch[key] = rawValue;
    }
  }
  try {
    const data = await getSdk().admin.setNotificationPreferences(patch);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function test(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--source", "--type"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for notifications test: ${extra[0]}` });
  }
  const source = flagValue(parsedArgs, "--source");
  if (source !== null) assertAllowedValue(source, ["app", "platform"], "--source");
  const eventType = flagValue(parsedArgs, "--type");
  allowanceAuthHeaders("/agent/v1/notifications/test");
  const opts = {};
  if (source) opts.source = source;
  if (eventType) opts.eventType = eventType;
  try {
    const data = await getSdk().admin.testNotification(opts);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

// ---------------------------------------------------------------------------
// Telegram channel bindings — notification-channel-routing-telegram.
// ---------------------------------------------------------------------------

const TELEGRAM_CONNECT_POLL_INTERVAL_MS = 3000;
/** Fallback wait bound if the server's code_expires_at is somehow
 *  unparseable — the connect code's real TTL is 15 minutes server-side. */
const TELEGRAM_CONNECT_FALLBACK_TIMEOUT_MS = 20 * 60 * 1000;
/** Print a progress line every Nth poll tick (~15s at the interval above) —
 *  frequent enough to reassure, not so frequent it floods stderr. */
const TELEGRAM_CONNECT_PROGRESS_EVERY_N_TICKS = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `GET /agent/v1/notifications/channels` until `bindingId` shows
 * `status: "active"`, or the connect code's `codeExpiresAt` passes.
 * Transient poll failures (network blips) are logged and retried rather
 * than aborting the whole connect flow — bounded by the same expiry.
 */
async function pollTelegramBindingActive(bindingId, codeExpiresAt) {
  const parsedExpiry = Date.parse(codeExpiresAt);
  const deadlineMs = Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + TELEGRAM_CONNECT_FALLBACK_TIMEOUT_MS;
  let tick = 0;
  for (;;) {
    await sleep(TELEGRAM_CONNECT_POLL_INTERVAL_MS);
    tick += 1;
    let channels;
    try {
      channels = await getSdk().admin.channels.list();
    } catch (err) {
      console.error(`  (poll failed, retrying: ${err?.message || err})`);
      if (Date.now() >= deadlineMs) return { active: false, timedOut: true, binding: null };
      continue;
    }
    const binding = (channels.telegram || []).find((b) => b.id === bindingId) || null;
    if (binding && binding.status === "active") {
      return { active: true, binding };
    }
    if (Date.now() >= deadlineMs) {
      return { active: false, timedOut: true, binding };
    }
    if (tick % TELEGRAM_CONNECT_PROGRESS_EVERY_N_TICKS === 1) {
      const remainingSec = Math.max(0, Math.round((deadlineMs - Date.now()) / 1000));
      const status = binding ? binding.status : "pending";
      console.error(`  waiting for you to tap the link in Telegram... (status: ${status}, ${remainingSec}s left)`);
    }
  }
}

async function channelsConnect(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--label", "--help", "-h"], ["--label"]);
  const label = flagValue(a, "--label");
  const positionals = positionalArgs(a, ["--label"]);
  if (positionals.length === 0) {
    fail({
      code: "BAD_USAGE",
      message: "Usage: run402 notifications channels connect telegram [--label <name>]",
    });
  }
  if (positionals[0] !== "telegram") {
    fail({
      code: "BAD_USAGE",
      message: `Unknown channel type: ${positionals[0]}. Only 'telegram' is supported.`,
      details: { channel_type: positionals[0] },
    });
  }
  if (positionals.length > 1) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for notifications channels connect: ${positionals[1]}` });
  }

  allowanceAuthHeaders("/agent/v1/notifications/channels/telegram");
  let pending;
  try {
    pending = await getSdk().admin.channels.connectTelegram(label ? { label } : {});
  } catch (err) {
    reportSdkError(err);
    return;
  }

  console.error("");
  console.error("Open ONE of these links in Telegram and tap Start to connect this channel:");
  console.error(`  Private chat:  ${pending.connect_url}`);
  console.error(`  Group chat:    ${pending.connect_group_url}`);
  console.error(`  Expires:       ${pending.code_expires_at}`);
  console.error("");
  console.error("Waiting for you to tap the link...");

  const outcome = await pollTelegramBindingActive(pending.binding_id, pending.code_expires_at);
  if (outcome.active) {
    console.error("Connected.");
    console.log(JSON.stringify({ ...pending, connected: true, binding: outcome.binding }, null, 2));
    return;
  }
  console.error("Timed out waiting for you to tap the link — the connect code has expired.");
  console.error("Run `run402 notifications channels connect telegram` again for a fresh link.");
  console.log(JSON.stringify({ ...pending, connected: false, timed_out: true }, null, 2));
  process.exit(1);
}

async function channelsList() {
  allowanceAuthHeaders("/agent/v1/notifications/channels");
  try {
    console.log(JSON.stringify(await getSdk().admin.channels.list(), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function channelsRevoke(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  const [bindingId] = requirePositionalCount(a, [], {
    min: 1,
    max: 1,
    command: "run402 notifications channels revoke <binding_id>",
    missing: "Missing <binding_id>.",
  });
  allowanceAuthHeaders("/agent/v1/notifications/channels/telegram");
  try {
    console.log(JSON.stringify(await getSdk().admin.channels.revokeTelegram(bindingId), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function runChannels(args) {
  const channelsAction = args[0];
  const rest = args.slice(1);
  if (!channelsAction || channelsAction === "--help" || channelsAction === "-h") {
    console.log(CHANNELS_HELP);
    process.exit(channelsAction ? 0 : 1);
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(CHANNELS_HELP);
    process.exit(0);
  }

  if (channelsAction === "connect") {
    await channelsConnect(rest);
    return;
  }
  if (channelsAction === "list") {
    await channelsList();
    return;
  }
  if (channelsAction === "revoke") {
    await channelsRevoke(rest);
    return;
  }
  fail({
    code: "BAD_USAGE",
    message: `Unknown 'notifications channels' action: ${channelsAction}. Try connect | list | revoke.`,
  });
}

// ---------------------------------------------------------------------------
// Telegram routing rules — notification-channel-routing-telegram.
// ---------------------------------------------------------------------------

function splitCsv(value) {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function rulesAdd(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--binding", "--project", "--source", "--type", "--class"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  const positionals = positionalArgs(a, valueFlags);
  if (positionals.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for notifications rules add: ${positionals[0]}` });
  }

  const bindingId = flagValue(a, "--binding");
  if (!bindingId) {
    fail({
      code: "BAD_USAGE",
      message:
        "Usage: run402 notifications rules add --binding <binding_id> [--project <id>] [--source app|platform] [--type a,b] [--class a,b]",
    });
  }
  const projectId = flagValue(a, "--project");
  const source = flagValue(a, "--source");
  if (source !== null) assertAllowedValue(source, ["app", "platform"], "--source");
  const typeRaw = flagValue(a, "--type");
  const classRaw = flagValue(a, "--class");

  const input = { telegramBindingId: bindingId };
  if (projectId) input.projectId = projectId;
  if (source) input.source = source;
  if (typeRaw !== null) input.eventTypes = splitCsv(typeRaw);
  if (classRaw !== null) input.classes = splitCsv(classRaw);

  allowanceAuthHeaders("/agent/v1/notifications/rules");
  try {
    console.log(JSON.stringify(await getSdk().admin.rules.create(input), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function rulesList() {
  allowanceAuthHeaders("/agent/v1/notifications/rules");
  try {
    console.log(JSON.stringify(await getSdk().admin.rules.list(), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function rulesRm(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  const [ruleId] = requirePositionalCount(a, [], {
    min: 1,
    max: 1,
    command: "run402 notifications rules rm <rule_id>",
    missing: "Missing <rule_id>.",
  });
  allowanceAuthHeaders("/agent/v1/notifications/rules");
  try {
    console.log(JSON.stringify(await getSdk().admin.rules.delete(ruleId), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function runRules(args) {
  const rulesAction = args[0];
  const rest = args.slice(1);
  if (!rulesAction || rulesAction === "--help" || rulesAction === "-h") {
    console.log(RULES_HELP);
    process.exit(rulesAction ? 0 : 1);
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(RULES_HELP);
    process.exit(0);
  }

  if (rulesAction === "add") {
    await rulesAdd(rest);
    return;
  }
  if (rulesAction === "list") {
    await rulesList();
    return;
  }
  if (rulesAction === "rm") {
    await rulesRm(rest);
    return;
  }
  fail({
    code: "BAD_USAGE",
    message: `Unknown 'notifications rules' action: ${rulesAction}. Try add | list | rm.`,
  });
}

// ---------------------------------------------------------------------------
// Dispatch.
// ---------------------------------------------------------------------------

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    process.exit(0);
  }
  // Nested groups use `if (sub === ...)` (not `case`) so the sync test
  // extracts their leaf actions via the dedicated channelsAction/rulesAction
  // parsers, mirroring cli/lib/org.mjs's member/invite groups.
  if (sub === "channels") {
    await runChannels(args ?? []);
    return;
  }
  if (sub === "rules") {
    await runRules(args ?? []);
    return;
  }
  switch (sub) {
    case "list":
      await list(args);
      return;
    case "get":
      await get(args);
      return;
    case "preferences":
      await preferences(args);
      return;
    case "test":
      await test(args);
      return;
    default:
      fail({
        code: "UNKNOWN_SUBCOMMAND",
        message: `Unknown notifications subcommand: ${sub}`,
        hint: "Run `run402 notifications --help` for usage.",
        details: { command: "notifications", subcommand: sub },
      });
  }
}

// `run402 webhook-secret rotate` lives in cli/lib/webhook-secret.mjs as
// its own top-level command, separate from this notifications module.
