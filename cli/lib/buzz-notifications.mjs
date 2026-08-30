/**
 * `run402 buzz notifications` — project-event routing into a Buzz channel.
 *
 * Gateway subsystem: add-buzz-project-event-routing
 * (/buzz-project-event-routes/v1/*). JSON envelopes to stdout (pipe
 * contract); the authorization handoff and wait narration go to stderr.
 */
import { getSdk } from "./sdk.mjs";
import { fail, reportSdkError } from "./sdk-errors.mjs";
import { resolveOrgId } from "./org-context.mjs";
import {
  normalizeArgv,
  hasHelp,
  assertKnownFlags,
  parseIntegerFlag,
  flagValue,
  positionalArgs,
  requirePositionalCount,
  failUnknownSubcommand,
} from "./argparse.mjs";

const HELP = `run402 buzz notifications — route project events into a Buzz community channel

Usage:
  run402 buzz notifications configure --org <uuid> --installation <buzzci_id> --name <route_name> --channel <uuid> --project <id> [--project <id> ...] [--event-type <t> ...] [--event-class <c> ...]
  run402 buzz notifications status [--org <uuid> | <buzzper_id>]
  run402 buzz notifications test <buzzper_id> [--wait] [--poll-seconds <n>] [--timeout-seconds <n>]
  run402 buzz notifications deliveries <buzzper_id> [--limit <n>] [--cursor <c>] [--delivery <buzzped_id>]
  run402 buzz notifications pause <buzzper_id>
  run402 buzz notifications resume <buzzper_id>
  run402 buzz notifications rotate <buzzper_id>
  run402 buzz notifications revoke <buzzper_id>

THE WORKFLOW — configure -> authorize -> test -> live:
  1. configure   Creates the route. The response's \`authorization\` block is
                 either \`authorized\` (live now) or \`pending_buzz_authorization\`
                 with the ONE exact, non-secret handoff: a Buzz community owner
                 or admin adds the printed notification_pubkey as a relay
                 member (the approving human's own Buzz key lives in
                 Buzz Desktop -> Settings -> Profile -> Identity).
  2. authorize   Done on the Buzz side by that human — nothing to run here.
  3. test        Re-checks the Buzz-side membership (activating the route when
                 it landed) and queues one signed test message. \`--wait\` polls
                 the delivery for you.
  4. live        Matching project events flow as channel messages. NEW events
                 only — nothing that predates the route is ever delivered.

What can be routed:
  event types    deploy_activated, error_fingerprints_observed,
                 platform_incident — the three reviewed projectors. Nothing
                 else has one, so nothing else can be routed.
  event classes  security, billing_critical, destructive_lifecycle,
                 verification, and recovery may NEVER be routed to Buzz.
  Omitting --event-type/--event-class routes every registered type / every
  non-forbidden class. There is no empty filter: the gateway rejects [].

Buzz is never a deadman channel: mandatory operator notifications keep their
human paths (email, Telegram) regardless of route state, and a Buzz delivery
acknowledges nothing.

Delivery semantics:
  At-least-once, one row per (route, event), byte-identical republish on
  retry. Backoff 1m/5m/30m/2h/12h to 8 attempts or 48h, then dead_letter —
  visible in \`deliveries\`. Ten consecutive hard failures auto-pause the
  route (pause_reason: delivery_failures); \`resume\` re-arms it.

Security:
  - JSON stdout only; progress and the authorization handoff go to stderr.
  - No command here ever accepts or prints a signing secret — the
    notification_pubkey and signing_generation are the only credential
    material on the wire. \`rotate\` stages the NEXT key; the swap activates
    only after its own Buzz-side membership verifies.
  - Every command in this group has zero spend impact.

Examples:
  run402 buzz notifications configure --org 8f14…-uuid --installation buzzci_… --name deploys --channel <nip29-channel-id> --project prj_myapp --event-type deploy_activated
  run402 buzz notifications test buzzper_… --wait
  run402 buzz notifications deliveries buzzper_… --limit 20
`;

function out(value) {
  console.log(JSON.stringify(value, null, 2));
}

/** All values of a repeatable value-flag, in argv order. */
function flagValues(args, flag) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    if (i + 1 >= args.length || (typeof args[i + 1] === "string" && args[i + 1].startsWith("--"))) {
      fail({ code: "BAD_FLAG", message: `${flag} requires a value`, details: { flag } });
    }
    values.push(args[i + 1]);
    i += 1;
  }
  return values;
}

function requiredFlag(args, flag) {
  const value = flagValue(args, flag);
  if (value === null) fail({ code: "BAD_FLAG", message: `${flag} is required`, details: { flag } });
  return value;
}

/**
 * The authorization block is the one exact handoff a human must complete —
 * it goes to stderr LOUDLY (the JSON on stdout already carries it verbatim).
 */
function narrateAuthorization(authorization) {
  if (!authorization || authorization.status !== "pending_buzz_authorization") return;
  console.error("PENDING BUZZ AUTHORIZATION — the route cannot deliver until a Buzz community owner or admin completes this handoff:");
  console.error(`  notification_pubkey: ${authorization.notification_pubkey}`);
  if (authorization.connect_command) console.error(`  connect command:     ${authorization.connect_command}`);
  if (authorization.instructions) console.error(`  ${authorization.instructions}`);
  console.error("  (The approving human's Buzz key lives in Buzz Desktop -> Settings -> Profile -> Identity.)");
  console.error("  Then run `run402 buzz notifications test <buzzper_id> --wait` to verify it landed.");
}

async function configure(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--org", "--installation", "--name", "--channel", "--project", "--event-type", "--event-class", "--idempotency-key"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  requirePositionalCount(positionalArgs(a, valueFlags), valueFlags, {
    min: 0, max: 0, command: "run402 buzz notifications configure", missing: "",
  });
  const projectIds = flagValues(a, "--project");
  if (projectIds.length === 0) {
    fail({ code: "BAD_FLAG", message: "--project is required at least once — a route's scope is always explicit", details: { flag: "--project" } });
  }
  const eventTypes = flagValues(a, "--event-type");
  const eventClasses = flagValues(a, "--event-class");
  try {
    const created = await getSdk().buzz.notifications.createRoute(await resolveOrgId(a, { cmd: "buzz" }), {
      installationId: requiredFlag(a, "--installation"),
      routeName: requiredFlag(a, "--name"),
      buzzChannelId: requiredFlag(a, "--channel"),
      projectIds,
      ...(eventTypes.length ? { eventTypes } : {}),
      ...(eventClasses.length ? { eventClasses } : {}),
      ...(flagValue(a, "--idempotency-key") ? { idempotencyKey: flagValue(a, "--idempotency-key") } : {}),
    });
    out(created);
    narrateAuthorization(created.authorization);
    if (created.authorization?.status === "authorized") {
      console.error("Route is authorized and active. Run `run402 buzz notifications test <buzzper_id> --wait` to see a delivery land.");
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function status(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--org"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  const positionals = requirePositionalCount(positionalArgs(a, valueFlags), valueFlags, {
    min: 0, max: 1, command: "run402 buzz notifications status [--org <uuid> | <buzzper_id>]", missing: "",
  });
  try {
    const sdk = getSdk();
    if (positionals.length === 1) {
      out(await sdk.buzz.notifications.get(positionals[0]));
      return;
    }
    const routes = await sdk.buzz.notifications.list(await resolveOrgId(a, { cmd: "buzz" }));
    out({ buzz_project_event_routes: routes });
  } catch (err) {
    reportSdkError(err);
  }
}

async function test(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--poll-seconds", "--timeout-seconds", "--idempotency-key"];
  assertKnownFlags(a, [...valueFlags, "--wait", "--help", "-h"], valueFlags);
  const positionals = requirePositionalCount(positionalArgs(a, valueFlags), valueFlags, {
    min: 1, max: 1, command: "run402 buzz notifications test", missing: "<buzzper_id>",
  });
  const routeId = positionals[0];
  const idempotencyKey = flagValue(a, "--idempotency-key") ?? undefined;
  try {
    const sdk = getSdk();
    if (!a.includes("--wait")) {
      const queued = await sdk.buzz.notifications.test(routeId, idempotencyKey);
      out(queued);
      console.error(`Queued ${queued.buzz_project_event_delivery_id} — the tick publishes within ~60s. Poll: run402 buzz notifications deliveries ${routeId} --delivery ${queued.buzz_project_event_delivery_id}`);
      return;
    }
    const pollSeconds = flagValue(a, "--poll-seconds");
    const timeoutSeconds = flagValue(a, "--timeout-seconds");
    const pollMs = (pollSeconds != null ? parseIntegerFlag("--poll-seconds", pollSeconds, { min: 2, max: 600 }) : 5) * 1000;
    const timeoutMs = (timeoutSeconds != null ? parseIntegerFlag("--timeout-seconds", timeoutSeconds, { min: 10, max: 3600 }) : 180) * 1000;
    // The SDK owns the wait (shared waitFor contract: a timeout RETURNS the
    // still-queued delivery, never throws). The CLI only narrates on stderr —
    // stdout stays one JSON doc (the pipe contract).
    let announced = false;
    const delivery = await sdk.buzz.notifications.testAndWait(routeId, {
      pollMs,
      timeoutMs,
      onPoll: (state) => {
        if (!announced) {
          announced = true;
          console.error(`Queued ${state.buzz_project_event_delivery_id} (${state.status}); waiting for the publisher tick…`);
        }
      },
    });
    out(delivery);
    if (delivery.status === "delivered") {
      console.error(`Delivered — Nostr event ${delivery.nostr_event_id ?? "(id pending)"} is on the relay. The route is live.`);
    } else if (delivery.status === "queued" || delivery.status === "retryable") {
      console.error("Timed out still queued — the tick publishes within ~60s; silence is not failure, poll deliveries. If the route was pending authorization, the Buzz-side member-add may not have landed yet.");
      process.exitCode = 2;
    } else {
      console.error(`Terminal without delivering (${delivery.status}${delivery.last_error ? `: ${delivery.last_error}` : ""}) — inspect \`run402 buzz notifications status ${routeId}\` for route health.`);
      process.exitCode = 2;
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function deliveries(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--limit", "--cursor", "--delivery"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  const positionals = requirePositionalCount(positionalArgs(a, valueFlags), valueFlags, {
    min: 1, max: 1, command: "run402 buzz notifications deliveries", missing: "<buzzper_id>",
  });
  try {
    out(await getSdk().buzz.notifications.deliveries(positionals[0], {
      ...(flagValue(a, "--limit") != null
        ? { limit: parseIntegerFlag("--limit", flagValue(a, "--limit"), { min: 1, max: 200 }) }
        : {}),
      ...(flagValue(a, "--cursor") ? { cursor: flagValue(a, "--cursor") } : {}),
      ...(flagValue(a, "--delivery") ? { deliveryId: flagValue(a, "--delivery") } : {}),
    }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function lifecycle(action, args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--idempotency-key"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  const positionals = requirePositionalCount(positionalArgs(a, valueFlags), valueFlags, {
    min: 1, max: 1, command: `run402 buzz notifications ${action}`, missing: "<buzzper_id>",
  });
  const routeId = positionals[0];
  const idempotencyKey = flagValue(a, "--idempotency-key") ?? undefined;
  try {
    const sdk = getSdk();
    if (action === "rotate") {
      const staged = await sdk.buzz.notifications.rotate(routeId, idempotencyKey);
      out(staged);
      console.error("Rotation STAGED, not active: the current key keeps signing until the NEXT pubkey's own Buzz-side membership verifies.");
      narrateAuthorization({
        status: "pending_buzz_authorization",
        notification_pubkey: staged.rotation?.next_notification_pubkey,
        instructions: staged.rotation?.authorize_hint,
      });
      return;
    }
    if (action === "revoke") {
      const revoked = await sdk.buzz.notifications.revoke(routeId, idempotencyKey);
      out(revoked);
      if (revoked.notification_credential_destroyed) {
        console.error("This was the installation's last live route — its notification credential was destroyed with it.");
      }
      console.error("Queued deliveries were cancelled; the route's sanitized history stays readable.");
      return;
    }
    out(action === "pause"
      ? await sdk.buzz.notifications.pause(routeId, idempotencyKey)
      : await sdk.buzz.notifications.resume(routeId, idempotencyKey));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  const argv = Array.isArray(args) ? args : [];
  if (!sub || sub === "help" || hasHelp([sub, ...argv])) {
    console.log(HELP);
    return;
  }
  switch (sub) {
    case "configure":
      await configure(argv);
      break;
    case "status":
      await status(argv);
      break;
    case "test":
      await test(argv);
      break;
    case "deliveries":
      await deliveries(argv);
      break;
    case "pause":
    case "resume":
    case "rotate":
    case "revoke":
      await lifecycle(sub, argv);
      break;
    default:
      failUnknownSubcommand("buzz notifications", sub, {
        hint: "Run `run402 buzz notifications --help` for usage.",
      });
  }
}
