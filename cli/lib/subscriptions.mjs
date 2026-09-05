/**
 * `run402 subscriptions` — which events reach which destination.
 *
 * Was `run402 notifications rules`. One subscription is one match (project,
 * source, event types, classes) resolving to one destination.
 *
 * HONESTY NOTE (legible-cli-surface D5): this surface accepts subscriptions it
 * cannot currently honour. The delivery pipeline consumes `source IN
 * ('app','agent-messaging')`, so a subscription naming a platform-emitted type
 * — a lifecycle cliff, an error rollup — is stored, listed back as enabled,
 * and never fires. Measured in production: one live rule, five such types, 101
 * qualifying events, zero delivered. The gateway reports this at create time;
 * the pipeline widening that removes the need for the report is a filed
 * successor, and the report must stop firing because the pipeline carries
 * those events — never because the check was removed.
 *
 * HTTP paths unchanged (`/agent/v1/notifications/rules*`); the allowance auth
 * headers are PATH-scoped and must keep naming the real route.
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
} from "./argparse.mjs";

const HELP = `run402 subscriptions — which events go where

Usage:
  run402 subscriptions add --contact <binding_id> [--project <id>] [--source app|platform] [--type a,b] [--class a,b]
  run402 subscriptions list
  run402 subscriptions rm <subscription_id>

Notes:
  - Absent dimensions are wildcards; an explicit empty list matches NOTHING.
  - A subscription naming a platform-emitted event type cannot match today —
    the delivery pipeline carries app and agent-messaging sources only. The
    gateway says so when you create one.
  - Where a human is reachable is \`run402 contacts\`; what actually landed is
    \`run402 deliveries\`.
`;

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
    console.log(JSON.stringify(await getSdk().admin.rules.create(input, operatorProofs("/agent/v1/notifications/rules")), null, 2));
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
    console.log(JSON.stringify(await getSdk().admin.rules.delete(ruleId, operatorProofs("/agent/v1/notifications/rules")), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}


export async function run(sub, args) {
  const rest = Array.isArray(args) ? args : [];
  // `--help` arrives as the SUBCOMMAND (`run402 subscriptions --help`), not
  // only inside args — check both, the way every other family does.
  if (!sub || hasHelp([sub, ...rest])) {
    console.log(HELP);
    process.exit(0);
  }
  switch (sub) {
    case "add":
      await rulesAdd(rest);
      return;
    case "list":
      await rulesList();
      return;
    case "rm":
      await rulesRm(rest);
      return;
    default:
      failUnknownSubcommand("subscriptions", sub);
  }
}
