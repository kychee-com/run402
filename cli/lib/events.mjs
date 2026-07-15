/**
 * run402 events — the cursored project events feed (gateway
 * project-events-outbox). One call answers "what happened to my project
 * since I last looked": deploy activations, mailbox suspensions, transfers,
 * lifecycle cliffs, verification outcomes — each with platform-synthesized
 * next_actions drill-downs. The feed also carries app-emitted business
 * facts (a deployed function's own `events.emit(...)` calls) alongside the
 * platform's own events — filter with --source/--type.
 *
 * JSON envelope to stdout (pipe contract); flags map 1:1 to the HTTP query.
 * The CLI passes the cursor through opaquely and never reinterprets
 * reset/earliest_cursor — the platform owns the feed semantics.
 */

import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertAllowedValue, assertKnownFlags, flagValue, normalizeArgv, positionalArgs } from "./argparse.mjs";

/** Wire `source` vocabulary (mirrors the gateway's app/platform dichotomy). */
export const SOURCES = ["app", "platform"];

const HELP = `run402 events — what happened to your project since you last looked

Usage:
  run402 events [--project <project_id>] [--cursor <cursor>] [--limit <n>]
                [--source <app|platform>] [--type <name[,name]>]
  run402 events --org <org_id> [--cursor <cursor>] [--limit <n>]
                [--source <app|platform>] [--type <name[,name]>]

Options:
  --project <id>    Project to read (defaults to the active project)
  --org <id>        Read the org-wide feed instead (union across the org's projects)
  --cursor <cursor> Opaque cursor from a previous response. Returns events strictly
                    after it. Omit on first contact to start from the earliest
                    retained event.
  --limit <n>       Page size (default 50, max 200)
  --source <s>      Restrict to one source: ${SOURCES.join(" | ")}
  --type <names>    Restrict to one or more event types, comma-separated
                     (e.g. signature_completed,booking_created)

App events vs platform events:
  Every row is source-discriminated. "platform" is the platform's own
  operational record (deploy activations, mailbox suspensions, transfers,
  lifecycle cliffs, verification outcomes, ...) — the platform's internal
  producers (gateway, email-lambda, ...) all collapse under this one value.
  "app" is business facts a deployed function emitted itself via
  \`events.emit(type, payload?, {idempotencyKey?})\` from @run402/functions —
  e.g. "signature_completed" or "booking_created". Consumers should key on
  the PAIR (source, event_type) together: app event_type names are free-form
  per app, so a future platform type could in principle share a name with
  one your app already uses — the source field is what disambiguates.
  Omit --source to read both lanes in one merged, cursor-ordered feed.

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
  run402 events --source app                   # just this project's own emitted business facts
  run402 events --source app --type signature_completed,booking_created
  run402 events --source platform              # just the platform's operational record
`;

export async function run(sub, args) {
  // Flat command: no subcommands. `sub` is the first arg (may be a flag).
  const argv = [sub, ...(Array.isArray(args) ? args : [])].filter((a) => a !== undefined && a !== null);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  const a = normalizeArgv(argv);
  const valueFlags = ["--project", "--org", "--cursor", "--limit", "--source", "--type"];
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
  const source = flagValue(a, "--source");
  const type = flagValue(a, "--type");
  if (cursor != null) opts.cursor = cursor;
  if (limit != null) opts.limit = Number(limit);
  if (source != null) {
    assertAllowedValue(source, SOURCES, "--source");
    opts.source = source;
  }
  if (type != null) opts.eventType = type;

  try {
    const page = org
      ? await getSdk().events.listForOrg(org, opts)
      : await getSdk().events.list(resolveProjectId(project), opts);
    console.log(JSON.stringify(page, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}
