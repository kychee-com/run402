/**
 * `run402 deliveries` — the record of whether a notification actually landed.
 *
 * Split out of `run402 notifications` by legible-cli-surface: that group was
 * two nouns in one coat. `list`/`get` read DELIVERY RECORDS (what was sent,
 * where, and whether it arrived); the rest of it was the CONFIGURATION that
 * produces them, which is now `contacts` and `subscriptions`.
 *
 * HTTP paths are unchanged (`/agent/v1/notifications*`) — this is client
 * vocabulary, and the allowance auth headers below are PATH-scoped, so they
 * must keep naming the real route. Renaming them would ship broken auth
 * against a live path, which is exactly how the `feedback` rename nearly went
 * wrong.
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
  failUnknownSubcommand,
  hasHelp,
} from "./argparse.mjs";

const HELP = `run402 deliveries — did a notification actually land

Usage:
  run402 deliveries list [--type <event_type>] [--since <iso>] [--limit N] [--after <cursor>]
  run402 deliveries get <id>

Notes:
  - One row per delivery ATTEMPT, per channel, with its outcome — the audit
    trail behind an email, webhook, or Telegram send.
  - Who gets reached is \`run402 contacts\`; which events route where is
    \`run402 subscriptions\`.
`;

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

export async function run(sub, args) {
  // `--help` arrives as the SUBCOMMAND (`run402 contacts --help`), not only
  // inside args — check both, the way every other family does.
  if (!sub || hasHelp([sub, ...(Array.isArray(args) ? args : [])])) {
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
    default:
      failUnknownSubcommand("deliveries", sub);
  }
}
