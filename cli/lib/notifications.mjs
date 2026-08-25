/**
 * `run402 notifications` — RETIRED (legible-cli-surface).
 *
 * The group was two nouns in one coat: `list`/`get` read delivery RECORDS
 * while `preferences`/`channels`/`rules` were the CONFIGURATION producing
 * them. It has been split along that line:
 *
 *   notifications list|get      -> deliveries list|get
 *   notifications channels      -> contacts        (merged with escalations contacts)
 *   notifications rules         -> subscriptions
 *   notifications preferences   -> contacts preferences
 *
 * Reserved, not aliased (design D3): each subcommand names its successor so
 * one failed call teaches the new model, where an alias would teach the old
 * one forever.
 */
import { fail } from "./sdk-errors.mjs";
import { hasHelp } from "./argparse.mjs";

const MOVED = {
  list: "deliveries list",
  get: "deliveries get",
  channels: "contacts",
  rules: "subscriptions",
  preferences: "contacts preferences",
  test: "contacts preferences",
};

const HELP = `run402 notifications — SPLIT into three nouns

Usage:
  run402 deliveries <list|get>          delivery records — did it land
  run402 contacts <list|add|connect|rm|preferences|test>
                                        where a human is reachable
  run402 subscriptions <add|list|rm>    which events go where

The group mixed delivery RECORDS with the CONFIGURATION that produces them.
Where everything went:

  notifications list|get      ->  run402 deliveries list|get
  notifications channels      ->  run402 contacts        (merged with the
                                  escalation paging ladder — one question:
                                  where is a human reachable)
  notifications rules         ->  run402 subscriptions
  notifications preferences   ->  run402 contacts preferences
  notifications test          ->  run402 contacts test

Run \`run402 deliveries --help\`, \`run402 contacts --help\`, or
\`run402 subscriptions --help\`.
`;

export async function run(sub, args) {
  // `--help` is a QUESTION, and the most useful answer to "help me with
  // notifications" is where everything moved — not a failure. Actually
  // invoking a moved subcommand still fails, naming its successor.
  if (!sub || hasHelp([sub, ...(Array.isArray(args) ? args : [])])) {
    console.log(HELP);
    process.exit(0);
  }
  const now = MOVED[sub];
  fail({
    code: "COMMAND_REMOVED",
    message: now
      ? `\`run402 notifications ${sub}\` moved to \`run402 ${now}\`.`
      : "`run402 notifications` was split into `deliveries`, `contacts` and `subscriptions`.",
    hint: now ? `run402 ${now}` : "run402 deliveries --help | run402 contacts --help | run402 subscriptions --help",
    details: {
      was: `notifications${sub ? ` ${sub}` : ""}`,
      now: now ?? null,
      why: "the group mixed delivery RECORDS with the CONFIGURATION that produces them",
      moved: MOVED,
    },
  });
}
