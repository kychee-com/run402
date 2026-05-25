/**
 * run402 notifications — Operator health notifications.
 *
 * Wraps the v1.55 `add-operator-health-notifications` API surface:
 *
 *   - run402 notifications list [--type ...] [--since ...] [--limit N] [--offset N]
 *   - run402 notifications get <id>
 *   - run402 notifications preferences [get|set ...]
 *   - run402 notifications test
 *   - run402 webhook-secret rotate
 *
 * All commands use the allowance-wallet auth path (SIWX). The assurance
 * ladder is enforced server-side; CLI surfaces 403 errors with the
 * required-assurance hint.
 */

import { allowanceAuthHeaders } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs } from "./argparse.mjs";

const HELP = `run402 notifications — Operator health notifications

Usage:
  run402 notifications list [--type <event_type>] [--since <iso>] [--limit N] [--offset N]
  run402 notifications get <id>
  run402 notifications preferences
  run402 notifications preferences set <key>=<value> [<key>=<value> ...]
  run402 notifications test

Examples:
  run402 notifications list --limit 10
  run402 notifications list --type project_past_due --since 2026-05-01T00:00:00Z
  run402 notifications get 9b21fa0a-...
  run402 notifications preferences
  run402 notifications preferences set digest_cadence=weekly digest_day_of_week=1
  run402 notifications preferences set webhook_url=https://my-receiver.example.com/hook
  run402 notifications test

Auth ladder (enforced server-side):
  - SIWX wallet:      read own notifications + preferences
  - email_verified:   cross-wallet rollup reads + multi-wallet preference updates
  - operator_passkey: webhook URL changes, webhook secret rotation
`;

async function list(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--type", "--since", "--limit", "--offset"];
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
  const offset = flagValue(parsedArgs, "--offset");
  if (type) opts.type = type;
  if (since) opts.since = since;
  if (limit != null) opts.limit = Number(limit);
  if (offset != null) opts.offset = Number(offset);
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
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const extra = positionalArgs(parsedArgs);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for notifications test: ${extra[0]}` });
  }
  allowanceAuthHeaders("/agent/v1/notifications/test");
  try {
    const data = await getSdk().admin.testNotification();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    process.exit(0);
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
      fail({ code: "BAD_USAGE", message: `Unknown notifications subcommand: ${sub}\n\n${HELP}` });
  }
}

// `run402 webhook-secret rotate` lives in cli/lib/webhook-secret.mjs as
// its own top-level command, separate from this notifications module.
