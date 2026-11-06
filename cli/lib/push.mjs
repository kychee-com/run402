/**
 * run402 push — check a project's push notifications, and set the Firebase key
 * its phone app's devices are reached with. A deployed function sends with
 * `push.send(...)` from @run402/functions; `status` shows who is signed up
 * (browsers and phone-app devices), how much of the organization's daily
 * delivery cap is used, and what happened to each message.
 *
 * JSON envelope to stdout (pipe contract); thin shim over `r.push.status` /
 * `r.push.getMessage` / `r.push.setFcmCredential` / `r.push.removeFcmCredential`.
 */

import { readFileSync } from "node:fs";
import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs, failUnknownSubcommand } from "./argparse.mjs";

const HELP = `run402 push — push notifications: who is signed up, and did messages land

Usage:
  run402 push status [--project <project_id>]
  run402 push status --message <message_id> [--project <project_id>]
  run402 push fcm set --service-account <file.json> [--project <project_id>]
  run402 push fcm remove [--project <project_id>]

Options:
  --project <project_id>  Project to read (defaults to the active project)
  --message <message_id>  Read one message (pmsg_…) and its per-phone deliveries
                          instead of the project summary

Without --message, prints:
  { project_id,
    providers: { fcm: { configured, firebase_project_id, client_email, key_id,
      set_at, last_error, last_error_at } },
    subscriptions: { total, users: [{ user_id, phones: [{ subscription_id,
      push_service, created_at, last_confirmed_at, last_accepted_at }] }],
      users_shown, users_total, has_more },
    devices: { total, users: [{ user_id, devices: [{ device_id, provider,
      created_at, last_confirmed_at, last_accepted_at }] }], users_shown,
      users_total, has_more },
    usage: { deliveries_today, limit, resets_at, scope: "organization", org_id },
    messages: [{ message_id, created_at, status, devices, outcomes }] }
  messages is the latest 10. A message's status is no_subscribers | queued |
  sending | completed; outcomes counts its deliveries by state.

With --message, prints the message (title, body, url, tag, data, to, status,
devices, outcomes) and deliveries[]: { kind: "web" | "native", subscription_id
(web) or device_id and provider (native), user_id, push_service, status,
attempts, last_status, last_error, updated_at }. A delivery's status is
queued | retrying | accepted | removed | failed; removed means the push service
said the phone or device is gone (or the device's session ended) and the
platform deleted it. An unknown message id (or another project's) is a 404.

Phone apps: "push fcm set" gives Run402 the project's Firebase service-account
key (the JSON file Firebase downloads: Project settings, Service accounts,
Generate new private key). Run402 checks it with Google (422 when Google refuses
it), keeps it encrypted and prints only its public fields; a key for another
Firebase project removes the devices registered under the old one
(devices_removed). The phone app, signed in with native sign-in, then registers
its Firebase token at POST /_run402/push/devices on the app's host. "push fcm
remove" removes the key and every device registered under it.

Sending happens inside a deployed function: push.send({ title, body?, url?, tag?,
data?, to? }) from @run402/functions. One call reaches browsers and phone-app
devices. With data, a device gets only data (plus run402_message_id, run402_url,
run402_tag) and never the title or body; browsers never get data, and a message
with only data reaches phone apps only. The daily cap counts deliveries per organization
per UTC day (100 prototype, 1,000 hobby, 10,000 team); a message that does not
fit is refused whole: 403 QUOTA_EXCEEDED with an upgrade next action, or on team
(no higher tier) 429 RATE_LIMITED with Retry-After until the UTC day resets.

Auth: the project's service_key, your SIWX wallet, a sign-in session, or a grant
key with project.read (status) or secrets.write (fcm set, fcm remove).

Examples:
  run402 push status
  run402 push status --project prj_abc
  run402 push status --message pmsg_123 --project prj_abc
  run402 push fcm set --service-account ./firebase-key.json
  run402 push fcm remove --project prj_abc
`;

export async function run(sub, args) {
  const rest = Array.isArray(args) ? args : [];
  if (sub === undefined || sub === null || sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  if (sub === "fcm") return fcm(rest);
  switch (sub) {
    case "status": return status(rest);
    default:
      failUnknownSubcommand("push", sub);
  }
}

async function fcm(args) {
  const [fcmAction, ...rest] = args;
  if (fcmAction === "set") return fcmSet(rest);
  if (fcmAction === "remove") return fcmRemove(rest);
  return failUnknownSubcommand("push fcm", fcmAction);
}

function readServiceAccount(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    fail({ code: "FILE_NOT_FOUND", message: `Cannot read ${path}: ${err.message}`, hint: "Pass the JSON key file Firebase downloaded: --service-account <file.json>." });
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // reported below
  }
  return fail({ code: "BAD_USAGE", message: `${path} is not a JSON object`, hint: "Pass the service-account JSON file Firebase downloaded, unchanged." });
}

async function fcmSet(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--project", "--service-account"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  const extra = positionalArgs(a, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for push fcm set: ${extra[0]}`, hint: "Pass the key file as --service-account <file.json>." });
  }
  const file = flagValue(a, "--service-account");
  if (!file) {
    fail({ code: "BAD_USAGE", message: "push fcm set needs --service-account <file.json>", hint: "Download it in the Firebase console: Project settings, Service accounts, Generate new private key." });
  }
  const projectId = resolveProjectId(flagValue(a, "--project"));
  const serviceAccount = readServiceAccount(file);
  try {
    console.log(JSON.stringify(await getSdk().push.setFcmCredential(projectId, serviceAccount), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function fcmRemove(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--project"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  const extra = positionalArgs(a, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for push fcm remove: ${extra[0]}`, hint: "Run `run402 push --help` for usage." });
  }
  const projectId = resolveProjectId(flagValue(a, "--project"));
  try {
    console.log(JSON.stringify(await getSdk().push.removeFcmCredential(projectId), null, 2));
  } catch (err) {
    reportSdkError(err);
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
