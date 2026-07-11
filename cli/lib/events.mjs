/**
 * run402 events — the cursored project events feed (gateway
 * project-events-outbox). One call answers "what happened to my project
 * since I last looked": deploy activations, mailbox suspensions, transfers,
 * lifecycle cliffs, verification outcomes — each with platform-synthesized
 * next_actions drill-downs.
 *
 * JSON envelope to stdout (pipe contract); flags map 1:1 to the HTTP query.
 * The CLI passes the cursor through opaquely and never reinterprets
 * reset/earliest_cursor — the platform owns the feed semantics.
 */

import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs } from "./argparse.mjs";

const HELP = `run402 events — what happened to your project since you last looked

Usage:
  run402 events [--project <project_id>] [--cursor <cursor>] [--limit <n>]
  run402 events --org <org_id> [--cursor <cursor>] [--limit <n>]

Options:
  --project <id>    Project to read (defaults to the active project)
  --org <id>        Read the org-wide feed instead (union across the org's projects)
  --cursor <cursor> Opaque cursor from a previous response. Returns events strictly
                    after it. Omit on first contact to start from the earliest
                    retained event.
  --limit <n>       Page size (default 50, max 200)

The cursor model:
  - Every response carries "cursor": the high-water mark. Store it (a file in
    your repo, a memory note — wherever you keep state) and pass it back as
    --cursor next time. One call then returns everything you missed.
  - Cursors are opaque (evc_...). Never parse or compare them; any event's
    "id" is also a valid --cursor value to resume right after that event.
  - Events become visible within a couple of seconds of the change committing
    (a short visibility watermark orders concurrent writes). After that they
    are never lost: a cursor read misses nothing that committed before the
    cursor was issued.
  - "has_more": true means more events are immediately available — call again
    with the new cursor right away.

When your cursor is too old (reset semantics):
  - Feed retention is 90 days (365 for security/recovery/billing-critical
    classes). A cursor older than that — or malformed — still returns 200,
    with "reset": true and "earliest_cursor": the point to restart from.
    Nothing is silently skipped; you are told exactly what happened and how
    to proceed.

Event shape:
  { "id", "event_type", "class", "occurred_at", "payload", "next_actions" }
  event_type is flat snake_case: deploy_activated, mailbox_suspended,
  project_transfer_completed, organization_past_due, verification_failed,
  webhook_disabled, ... Each event's next_actions[] is the platform's own
  suggestion for the highest-probability follow-up call.

Auth:
  --project: the project's own service_key, your SIWX wallet, a control-plane
             session, or a scoped delegate with project.read.
  --org:     wallet / control-plane session with an active org membership
             (a project service_key cannot read sibling projects' events).
  The feed is read-only and never lifecycle-gated: a frozen project's feed
  stays readable — that's when you most need it.

Tip: every successful deploy (apply commit / promote) returns a next_actions
poll entry pointing at this feed with a cursor positioned just before your
own deploy_activated event — poll once after deploying to establish your
cursor, then catch up next session in one call.

Examples:
  run402 events                                # active project, from the earliest retained event
  run402 events --cursor evc_1a2b              # everything since last time
  run402 events --project prj_abc --limit 200
  run402 events --org 00000000-0000-0000-0000-aaaaaaaaaaaa --cursor evc_9z
`;

export async function run(sub, args) {
  // Flat command: no subcommands. `sub` is the first arg (may be a flag).
  const argv = [sub, ...(Array.isArray(args) ? args : [])].filter((a) => a !== undefined && a !== null);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  const a = normalizeArgv(argv);
  const valueFlags = ["--project", "--org", "--cursor", "--limit"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  const extra = positionalArgs(a, valueFlags);
  if (extra.length > 0) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for events: ${extra[0]}`,
      hint: "Run `run402 events --help` for usage.",
    });
  }

  const org = flagValue(a, "--org");
  const project = flagValue(a, "--project");
  if (org && project) {
    fail({
      code: "BAD_USAGE",
      message: "Pass either --project or --org, not both.",
      hint: "The org feed already unions every project the org owns.",
    });
  }

  const opts = {};
  const cursor = flagValue(a, "--cursor");
  const limit = flagValue(a, "--limit");
  if (cursor != null) opts.cursor = cursor;
  if (limit != null) opts.limit = Number(limit);

  try {
    const page = org
      ? await getSdk().events.listForOrg(org, opts)
      : await getSdk().events.list(resolveProjectId(project), opts);
    console.log(JSON.stringify(page, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}
