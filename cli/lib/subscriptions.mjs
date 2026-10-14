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
 * HTTP paths unchanged (`/agent/v1/notifications/rules*`); the SIWX auth
 * headers are PATH-scoped and must keep naming the real route.
 */
import { walletAuthHeaders } from "./config.mjs";
import { sessionProofs } from "./session-proofs.mjs";
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
  run402 subscriptions add --binding <binding_id> [--project <project_id>] [--source app|platform] [--type a,b] [--class a,b]
                           [--min-severity info|notice|warn|critical] [--group-by key[,key]] [--window <seconds>]
  run402 subscriptions add --escalate-to-level <n> --project <project_id> [--min-severity critical] [...filters]
  run402 subscriptions list
  run402 subscriptions rm <subscription_id>

Notes:
  - <binding_id> is the id of an ACTIVE telegram row in \`run402 contacts list\`.
    \`--contact <binding_id>\` is accepted as an alias of \`--binding\`.
  - Absent dimensions are wildcards; an explicit empty list matches NOTHING.
  - Severity is the emitter's to declare (info < notice < warn < critical);
    the rule only filters on it. Without --min-severity a rule carries notice
    and above when it names no --type, and everything of the types it names.
  - --window <seconds> (60-86400) sends ONE message per closed window instead of
    one per event: the total and a line per --group-by value with its count.
    --group-by needs --window. The feed still holds every event.
  - --escalate-to-level <n> pages your escalation ladder instead of a chat
    (mandatory delivery, one-tap ack, climb); a repeat while it is open joins
    it. It needs --project and owner authority on that project's org.
  - There is no count or rate condition: a rule never decides what is wrong.
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

/** Value flags `subscriptions add` accepts. Exported so the help/parser
 *  consistency test can assert every flag HELP teaches is one the parser
 *  takes — the v4.82.0 split rewrote HELP to `--contact` while the parser
 *  kept `--binding`, and nothing caught the drift. `--contact` stays as an
 *  alias for anyone who learned it from that help text. */
export const SUBSCRIPTIONS_ADD_VALUE_FLAGS = [
  "--binding", "--contact", "--project", "--source", "--type", "--class",
  "--min-severity", "--group-by", "--window", "--escalate-to-level",
];
export const SUBSCRIPTIONS_ADD_USAGE =
  "run402 subscriptions add (--binding <binding_id> | --escalate-to-level <n> --project <project_id>) [--project <project_id>] [--source app|platform] [--type a,b] [--class a,b] [--min-severity <level>] [--group-by a,b] [--window <seconds>]";

const SEVERITY_LEVELS = ["info", "notice", "warn", "critical"];

/** A positive integer flag, or a BAD_USAGE exit naming the flag. Range checks
 *  are the gateway's (it owns the bounds and says them in its 400). */
function integerFlag(raw, flag) {
  if (!/^\d+$/.test(raw)) {
    fail({ code: "BAD_USAGE", message: `${flag} must be a whole number (got ${raw})` });
  }
  return Number(raw);
}
export { HELP as SUBSCRIPTIONS_HELP };

async function rulesAdd(args) {
  const a = normalizeArgv(args);
  const valueFlags = SUBSCRIPTIONS_ADD_VALUE_FLAGS;
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  const positionals = positionalArgs(a, valueFlags);
  if (positionals.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for subscriptions add: ${positionals[0]}` });
  }

  const bindingId = flagValue(a, "--binding") ?? flagValue(a, "--contact");
  const levelRaw = flagValue(a, "--escalate-to-level");
  if (!bindingId === (levelRaw === null)) {
    // Exactly one destination: a chat binding, or the escalation ladder.
    fail({ code: "BAD_USAGE", message: `Usage: ${SUBSCRIPTIONS_ADD_USAGE}` });
  }
  const projectId = flagValue(a, "--project");
  const source = flagValue(a, "--source");
  if (source !== null) assertAllowedValue(source, ["app", "platform"], "--source");
  const typeRaw = flagValue(a, "--type");
  const classRaw = flagValue(a, "--class");

  const minSeverity = flagValue(a, "--min-severity");
  if (minSeverity !== null) assertAllowedValue(minSeverity, SEVERITY_LEVELS, "--min-severity");
  const groupByRaw = flagValue(a, "--group-by");
  const windowRaw = flagValue(a, "--window");

  const input = levelRaw === null
    ? { telegramBindingId: bindingId }
    : { channel: "escalation", escalationLevel: integerFlag(levelRaw, "--escalate-to-level") };
  if (minSeverity !== null) input.minSeverity = minSeverity;
  if (groupByRaw !== null) input.groupBy = splitCsv(groupByRaw);
  if (windowRaw !== null) input.windowSeconds = integerFlag(windowRaw, "--window");
  if (projectId) input.projectId = projectId;
  if (source) input.source = source;
  if (typeRaw !== null) input.eventTypes = splitCsv(typeRaw);
  if (classRaw !== null) input.classes = splitCsv(classRaw);

  walletAuthHeaders("/agent/v1/notifications/rules");
  try {
    console.log(JSON.stringify(await getSdk().admin.rules.create(input, await sessionProofs("/agent/v1/notifications/rules")), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function rulesList() {
  walletAuthHeaders("/agent/v1/notifications/rules");
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
    command: "run402 subscriptions rm <subscription_id>",
    missing: "Missing <rule_id>.",
  });
  walletAuthHeaders("/agent/v1/notifications/rules");
  try {
    console.log(JSON.stringify(await getSdk().admin.rules.delete(ruleId, await sessionProofs("/agent/v1/notifications/rules")), null, 2));
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
