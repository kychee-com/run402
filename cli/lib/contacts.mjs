/**
 * `run402 contacts` — where a human is reachable.
 *
 * ONE noun over two backends, merged by legible-cli-surface. `escalations
 * contacts` (the paging LADDER: an email at a level, climbed when nobody
 * answers) and `notifications channels` (a bound Telegram CHAT that routed
 * events reach) were the same idea under two names, and nothing in either
 * spelling suggested they were related.
 *
 * They stay distinguishable where it matters: every row carries `kind`, the
 * same way a feed event carries `source`. What is unified is the QUESTION —
 * "how can this human be reached" — not the mechanisms, which really are
 * different and are not pretended otherwise.
 *
 * `rm <id>` takes a bare id and works out which backend owns it, because both
 * are UUIDs and a caller holding one from `contacts list` should not have to
 * know which subsystem minted it. That costs one extra read and removes a
 * `--kind` flag nobody could answer without looking it up.
 *
 * HTTP paths are unchanged (`/agent/v1/notifications/channels*`,
 * `/orgs/v1/:org_id/escalation-contacts*`); the allowance auth headers below
 * are PATH-scoped and must keep naming the real routes.
 */
import { allowanceAuthHeaders } from "./config.mjs";
import { operatorProofs } from "./operator-proofs.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import {
  assertAllowedValue,
  assertKnownFlags,
  flagValue,
  normalizeArgv,
  positionalArgs,
  requirePositionalCount,
  failUnknownSubcommand,
  hasHelp,
  parseIntegerFlag,
} from "./argparse.mjs";
import { resolveOrgId } from "./org-context.mjs";

const HELP = `run402 contacts — where a human is reachable

Usage:
  run402 contacts list
  run402 contacts add <email> [--level <1-10>] [--name <display>]
  run402 contacts connect telegram [--label <name>]
  run402 contacts rm <id>
  run402 contacts preferences
  run402 contacts preferences set <key>=<value> [<key>=<value> ...]
  run402 contacts test [--source app|platform] [--type <event_type>]

Two kinds, one question:
  escalation   an email in the paging LADDER — \`add\`, with a --level that
               decides when it is climbed to. Paged out of band; no preference
               silences a mandatory class.
  telegram     a bound CHAT that routed events reach — \`connect\`. Which
               events reach it is \`run402 subscriptions\`.

Every row carries \`kind\`. \`rm\` takes either kind's id and works out which.

Notes:
  - Adding an address with no verified operator email is ACCEPTED with a
    reachability warning — you must be able to configure the chain before the
    humans are bound.
  - What actually landed is \`run402 deliveries\`.
`;

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
    const data = await getSdk().admin.setNotificationPreferences(patch, operatorProofs("/agent/v1/notifications/preferences"));
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

  const proofs = operatorProofs("/agent/v1/notifications/channels/telegram");
  let pending;
  try {
    pending = await getSdk().admin.channels.connectTelegram(label ? { label } : {}, proofs);
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
    console.log(JSON.stringify(await getSdk().admin.channels.revokeTelegram(bindingId, operatorProofs("/agent/v1/notifications/channels/telegram")), null, 2));
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
  failUnknownSubcommand("notifications channels", channelsAction, {
    hint: "Run `run402 notifications channels --help` for usage.",
  });
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

/** Both backends, one list. `kind` discriminates — the events feed's `source`
 *  pattern: unify the question, never pretend the mechanisms are the same. */
async function listContacts(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--org", "--help", "-h"], ["--org"]);
  const sdk = getSdk();
  const rows = [];
  const warnings = [];

  // Escalation ladder. A caller with no org context still gets the telegram
  // half rather than a hard failure — a partial answer that says so beats an
  // error that hides the half it could have given.
  try {
    const orgId = await resolveOrgId(a, { optional: true });
    if (orgId) {
      const res = await sdk.escalations.listContacts(orgId);
      for (const c of res.contacts ?? res.escalation_contacts ?? []) {
        rows.push({ kind: "escalation", id: c.contact_id ?? c.id, ...c });
      }
    } else {
      warnings.push("No organization resolved — escalation contacts omitted. Pass --org <org_id> to include them.");
    }
  } catch (err) {
    warnings.push(`escalation contacts unavailable: ${err?.message ?? String(err)}`);
  }

  try {
    allowanceAuthHeaders("/agent/v1/notifications/channels");
    const res = await sdk.admin.channels.list();
    for (const ch of res.channels ?? []) {
      rows.push({ kind: "telegram", id: ch.binding_id ?? ch.id, ...ch });
    }
  } catch (err) {
    warnings.push(`telegram channels unavailable: ${err?.message ?? String(err)}`);
  }

  console.log(JSON.stringify({ contacts: rows, ...(warnings.length ? { warnings } : {}) }, null, 2));
}

/** Remove either kind. The id alone does not say which backend owns it (both
 *  are UUIDs), so resolve it against the merged list rather than making the
 *  caller carry a flag they would have to look up anyway. */
async function removeContact(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--org", "--help", "-h"], ["--org"]);
  const positionals = positionalArgs(a, ["--org"]);
  requirePositionalCount(positionals, ["--org"], {
    min: 1, max: 1, command: "run402 contacts rm", missing: "<id>",
  });
  const id = positionals[0];
  const sdk = getSdk();

  try {
    const orgId = await resolveOrgId(a, { optional: true });
    if (orgId) {
      const res = await sdk.escalations.listContacts(orgId);
      const hit = (res.contacts ?? res.escalation_contacts ?? []).find((c) => (c.contact_id ?? c.id) === id);
      if (hit) {
        console.log(JSON.stringify({ kind: "escalation", ...(await sdk.escalations.removeContact(orgId, id)) }, null, 2));
        return;
      }
    }
    allowanceAuthHeaders("/agent/v1/notifications/channels");
    const chans = await sdk.admin.channels.list();
    const chan = (chans.channels ?? []).find((c) => (c.binding_id ?? c.id) === id);
    if (chan) {
      console.log(JSON.stringify({ kind: "telegram", ...(await sdk.admin.channels.revokeTelegram(id)) }, null, 2));
      return;
    }
    fail({
      code: "NOT_FOUND",
      message: `No contact with id ${id} in either the escalation ladder or your Telegram channels.`,
      hint: "run402 contacts list",
    });
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  // `--help` arrives as the SUBCOMMAND (`run402 contacts --help`), not only
  // inside args — check both, the way every other family does.
  if (!sub || hasHelp([sub, ...(Array.isArray(args) ? args : [])])) {
    console.log(HELP);
    process.exit(0);
  }
  const rest = Array.isArray(args) ? args : [];
  switch (sub) {
    case "list":
      await listContacts(rest);
      return;
    case "add": {
      // The paging ladder. `connect` is the other kind's verb — they are
      // different acts, the way `wallets new` and `wallets import` are.
      const a = normalizeArgv(rest);
      const valueFlags = ["--org", "--level", "--name"];
      assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
      const positionals = positionalArgs(a, valueFlags);
      requirePositionalCount(positionals, valueFlags, {
        min: 1, max: 1, command: "run402 contacts add", missing: "<email>",
      });
      try {
        const levelRaw = flagValue(a, "--level");
        const level = levelRaw != null ? parseIntegerFlag("--level", levelRaw, { min: 1, max: 10 }) : undefined;
        const created = await getSdk().escalations.addContact(await resolveOrgId(a), {
          email: positionals[0],
          ...(level !== undefined ? { level } : {}),
          ...(flagValue(a, "--name") ? { displayName: flagValue(a, "--name") } : {}),
        });
        console.log(JSON.stringify({ kind: "escalation", ...created }, null, 2));
        for (const w of created.warnings ?? []) console.error(w);
      } catch (err) {
        reportSdkError(err);
      }
      return;
    }
    case "connect":
      await runChannels(["connect", ...rest]);
      return;
    case "rm":
      await removeContact(rest);
      return;
    case "preferences":
      await preferences(rest);
      return;
    case "test":
      // "Am I actually reachable?" — sends a synthetic event through the
      // configured channels and subscriptions. It belongs to the noun that
      // owns reachability, not to the retired group it arrived in.
      await test(rest);
      return;
    default:
      failUnknownSubcommand("contacts", sub);
  }
}
