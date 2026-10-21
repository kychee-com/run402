/**
 * run402 push — check a project's web push notifications. A deployed function
 * sends with `push.send(...)` from @run402/functions; this command shows who is
 * signed up, how much of the organization's daily delivery cap is used, and
 * what happened to each message.
 *
 * JSON envelope to stdout (pipe contract); thin shim over `r.push.status` /
 * `r.push.getMessage`.
 */

import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs, failUnknownSubcommand } from "./argparse.mjs";

const HELP = `run402 push — web push notifications: who is signed up, and did messages land

Usage:
  run402 push status [--project <project_id>]
  run402 push status --message <message_id> [--project <project_id>]

Options:
  --project <project_id>  Project to read (defaults to the active project)
  --message <message_id>  Read one message (pmsg_…) and its per-phone deliveries
                          instead of the project summary

Without --message, prints:
  { project_id,
    subscriptions: { total, users: [{ user_id, phones: [{ subscription_id,
      push_service, created_at, last_confirmed_at, last_accepted_at }] }],
      users_shown, users_total, has_more },
    usage: { deliveries_today, limit, resets_at, scope: "organization", org_id },
    messages: [{ message_id, created_at, status, devices, outcomes }] }
  messages is the latest 10. A message's status is no_subscribers | queued |
  sending | completed; outcomes counts its deliveries by state.

With --message, prints the message (title, body, url, tag, to, status, devices,
outcomes) and deliveries[]: { subscription_id, user_id, push_service, status,
attempts, last_status, last_error, updated_at }. A delivery's status is
queued | retrying | accepted | removed | failed; removed means the push service
said the phone is gone and the platform deleted its subscription. An unknown
message id (or another project's) is a 404.

Sending happens inside a deployed function: push.send({ title, body?, url?, tag?,
to? }) from @run402/functions. The daily cap counts deliveries per organization
per UTC day (100 prototype, 1,000 hobby, 10,000 team); a message that does not
fit is refused whole: 403 QUOTA_EXCEEDED with an upgrade next action, or on team
(no higher tier) 429 RATE_LIMITED with Retry-After until the UTC day resets.

Auth: the project's service_key, your SIWX wallet, a sign-in session, or a grant
key with project.read.

Examples:
  run402 push status
  run402 push status --project prj_abc
  run402 push status --message pmsg_123 --project prj_abc
`;

export async function run(sub, args) {
  const rest = Array.isArray(args) ? args : [];
  if (sub === undefined || sub === null || sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  switch (sub) {
    case "status": return status(rest);
    default:
      failUnknownSubcommand("push", sub);
  }
}

async function status(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--project", "--message"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  const extra = positionalArgs(a, valueFlags);
  if (extra.length > 0) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for push status: ${extra[0]}`,
      hint: "Pass a message id as --message <message_id>. Run `run402 push --help` for usage.",
    });
  }

  const projectId = resolveProjectId(flagValue(a, "--project"));
  const messageId = flagValue(a, "--message");
  try {
    const result = messageId
      ? await getSdk().push.getMessage(projectId, messageId)
      : await getSdk().push.status(projectId);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}
