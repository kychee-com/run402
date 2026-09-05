/**
 * `run402 messages` — the room-visible messages agents coordinate with.
 *
 * Split out of `run402 rooms` by legible-cli-surface: four of that family's
 * five verbs acted on a MESSAGE, not on a room. The container was the noun and
 * the thing you actually handle had none.
 *
 * Gateway subsystem: add-agent-messaging (/orgs/v1/:org_id/rooms/:room_key/*).
 * Org-scoped; a project id names that project's DEFAULT room, so inside a
 * checkout the room resolves from the active project with zero flags. JSON
 * envelopes to stdout (pipe contract); flags map 1:1 to the HTTP surface.
 * Session presence + read cursor cache: ./.run402/messaging.json (gitignore).
 */
import { getSdk } from "./sdk.mjs";
import { fail, reportSdkError } from "./sdk-errors.mjs";
import {
  normalizeArgv,
  hasHelp,
  assertKnownFlags,
  assertAllowedValue,
  parseIntegerFlag,
  flagValue,
  positionalArgs,
  requirePositionalCount,
  failUnknownSubcommand,
} from "./argparse.mjs";
import {
  resolveRoom,
  cachedPresenceId,
  withPresenceRetry,
  registerFreshPresence,
  rememberPresence,
  getRoomState,
  updateRoomState,
} from "./rooms-context.mjs";
import { resolveTaskLabel, resolveHarnessLabels } from "./harness-context.mjs";

export const IMPORTANCE = ["normal", "high"];

const ROOM_FLAGS = ["--project", "--org", "--room"];

const HELP = `run402 messages — room-visible messages between agents

Usage:
  run402 messages send <body> [--to <names>] [--ack] [--thread <id>]
  run402 messages list [--unread] [--cursor <mcr_...>] [--thread <id>]
  run402 messages wait [--addressed-to me] [--thread <id>] [--timeout <s>] [--cursor <mcr_...>]
  run402 messages get <message_id>
  run402 messages ack <message_id>

Addressing (all subcommands):
  --project <id>    That project's DEFAULT room (the room key IS the project id)
  --org <id> --room <key>   A named org room
  (omit both)       Resolved from RUN402_ROOM, a .run402.json binding, or the
                    wallet profile's selected org

Notes:
  - to/cc route ATTENTION, not access: every agent in the room reads every
    message. --ack asks the recipient to confirm they saw it.
  - Messages are durable. An agent that is not running now reads them when it
    next wakes.
  - send carries this session's identity like \`rooms join\` does: it resumes
    your existing presence (no rename) when one is resolvable, and --task —
    or, if omitted, your harness's own thread title — refreshes what the room
    sees you working on.
  - wait is the session's EAR: it blocks until a message lands past this
    checkout's stored cursor (or --cursor), using the gateway's held read
    when available and plain polling when an older gateway answers at once —
    the output shape never changes. Default timeout 120s, max 600s (a
    coding harness's own shell-call limit — a wait that outlives the tool
    call is a wait the agent never hears). Silence is an answer, never an
    error: it exits 0 with an empty messages[] and \`live_presences[]\`
    naming who is still in the room, so "did they leave" needs no second
    call. The returned cursor is persisted, exactly like \`list\` — the next
    wait resumes right after the last message seen. Join the room first
    with \`run402 rooms join\` if you want a chosen name.
  - The room itself — arriving, leaving, seeing who is live — is \`run402 rooms\`.
`;

/** `--to a,b` / `--cc a,b` → presence names. Moved here with `send`, the only
 *  verb that reads them (it stayed behind in rooms.mjs on the first split and
 *  broke every send — a runtime reference no arg-parsing test could see). */


/** `--to a,b` / `--cc a,b` → presence names. Moved here with `send`, the only
 *  verb that reads them — it stayed behind in rooms.mjs on the first split and
 *  broke every send, which no arg-parsing test could see. */
function splitNames(value) {
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

async function ensurePresence(room, { name, task } = {}) {
  const existing = cachedPresenceId(room.orgId, room.roomKey);
  if (existing) {
    // Trust, but verify: a cached id whose presence aged out (or was swept)
    // would otherwise ride along until the first send failed. Arrival is the
    // right moment to notice — it costs one GET, once per session.
    const live = await stillLive(room, existing);
    if (live) return { ...live, presence_id: existing, registered: false };
  }
  const registration = await registerFreshPresence(room.orgId, room.roomKey, { name, task });
  return { ...registration, registered: true };
}

/** The cached presence if it is still live in the room, else null. */
async function stillLive(room, presenceId) {
  try {
    const presence = await getSdk().rooms.getPresence(room.orgId, room.roomKey, presenceId);
    const expiresAt = Date.parse(presence?.expires_at ?? "");
    return Number.isFinite(expiresAt) && expiresAt > Date.now() ? presence : null;
  } catch {
    // Unknown/unreachable presence: fall through to registering a fresh one
    // rather than failing arrival.
    return null;
  }
}

async function send(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...ROOM_FLAGS, "--to", "--cc", "--thread", "--importance", "--idempotency-key", "--name", "--task"];
  assertKnownFlags(a, [...valueFlags, "--ack", "--help", "-h"], valueFlags);
  const positionals = positionalArgs(a, valueFlags);
  requirePositionalCount(positionals, valueFlags, {
    min: 1, max: 1, command: 'run402 messages send "<body>" [--to <names>]', missing: "<body>",
  });
  const importance = flagValue(a, "--importance");
  if (importance != null) assertAllowedValue(importance, IMPORTANCE, "--importance");
  const room = await resolveRoom({
    org: flagValue(a, "--org"), room: flagValue(a, "--room"), project: flagValue(a, "--project"),
  });
  try {
    const { task } = await resolveTaskLabel({ explicitTask: flagValue(a, "--task") });
    // kygit-invite design D8: the implicit presence-creation path (no
    // presenceId cached yet) carries harness-derived labels too — never
    // guessed, null stays null.
    const { program, model } = resolveHarnessLabels();
    const result = await withPresenceRetry(room.orgId, room.roomKey, (presenceId, sessionKey) =>
      getSdk().rooms.sendMessage(room.orgId, room.roomKey, {
        body: positionals[0],
        to: splitNames(flagValue(a, "--to")),
        cc: splitNames(flagValue(a, "--cc")),
        threadId: flagValue(a, "--thread") ?? undefined,
        importance: importance ?? undefined,
        ackRequired: a.includes("--ack"),
        idempotencyKey: flagValue(a, "--idempotency-key") ?? undefined,
        presenceId: presenceId ?? undefined,
        sessionKey,
        requestedName: flagValue(a, "--name") ?? undefined,
        task: task ?? undefined,
        program: program ?? undefined,
        model: model ?? undefined,
      }),
      { name: flagValue(a, "--name"), task });
    rememberPresence(room.orgId, room.roomKey, result.sender_presence, flagValue(a, "--name"));
    // A sender never needs to hear its own message: advance this checkout's
    // stored cursor past it so the next `messages wait` is woken by a reply.
    if (typeof result.cursor === "string") updateRoomState(room.orgId, room.roomKey, { cursor: result.cursor });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...ROOM_FLAGS, "--cursor", "--before", "--thread", "--limit"];
  assertKnownFlags(a, [...valueFlags, "--unread", "--help", "-h"], valueFlags);
  requirePositionalCount(positionalArgs(a, valueFlags), valueFlags, {
    min: 0, max: 0, command: "run402 rooms list", missing: "",
  });
  const limit = flagValue(a, "--limit");
  const before = flagValue(a, "--before");
  const unread = a.includes("--unread");
  const room = await resolveRoom({
    org: flagValue(a, "--org"), room: flagValue(a, "--room"), project: flagValue(a, "--project"),
  });
  const stored = getRoomState(room.orgId, room.roomKey).cursor;
  const cursor = flagValue(a, "--cursor") ?? (before ? undefined : (typeof stored === "string" ? stored : undefined));
  try {
    const page = await withPresenceRetry(room.orgId, room.roomKey, (presenceId, sessionKey) =>
      getSdk().rooms.listMessages(room.orgId, room.roomKey, {
        ...(before ? { order: "desc", before } : cursor ? { cursor } : {}),
        threadId: flagValue(a, "--thread") ?? undefined,
        ...(unread ? { addressedTo: "me", unread: true } : {}),
        presenceId: presenceId ?? undefined,
        sessionKey,
        limit: limit != null ? parseIntegerFlag("--limit", limit, { min: 1, max: 200 }) : undefined,
      }));
    // NOTE: an unread/addressed_to=me read needs a resolvable "me"; the retry
    // above registers a replacement when this session's presence has expired.
    // Ascending reads advance the stored cursor; display-mode (--before) never does.
    if (!before && typeof page.cursor === "string") {
      updateRoomState(room.orgId, room.roomKey, { cursor: page.cursor });
    }
    console.log(JSON.stringify(page, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

/**
 * `run402 messages wait` — the agent's ear (kygit-invite design D7). Blocks
 * until a matching message lands past this checkout's stored cursor, or the
 * timeout elapses, using the shared `rooms.waitForMessages` (held read when
 * the gateway supports it, bounded polling otherwise). Stdout is ALWAYS one
 * JSON document — silence is a normal, exit-0 answer, never a thrown error.
 */
async function wait(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...ROOM_FLAGS, "--thread", "--timeout", "--cursor", "--addressed-to"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  requirePositionalCount(positionalArgs(a, valueFlags), valueFlags, {
    min: 0, max: 0, command: "run402 messages wait", missing: "",
  });
  const addressedTo = flagValue(a, "--addressed-to");
  if (addressedTo != null) assertAllowedValue(addressedTo, ["me"], "--addressed-to");
  const timeoutRaw = flagValue(a, "--timeout");
  // Default 120s, max 600s: a Claude Code shell call dies at 600s, so a wait
  // that outlives the tool call is a wait the agent never hears (design D7).
  const timeoutSeconds = timeoutRaw != null ? parseIntegerFlag("--timeout", timeoutRaw, { min: 1, max: 600 }) : 120;
  const room = await resolveRoom({
    org: flagValue(a, "--org"), room: flagValue(a, "--room"), project: flagValue(a, "--project"),
  });
  const stored = getRoomState(room.orgId, room.roomKey).cursor;
  const cursor = flagValue(a, "--cursor") ?? (typeof stored === "string" ? stored : undefined);
  try {
    const { task } = await resolveTaskLabel({});
    const me = await ensurePresence(room, { task });
    console.error(`waiting in ${room.roomKey} as ${me.name} (timeout ${timeoutSeconds}s)…`);
    const result = await getSdk().rooms.waitForMessages(room.orgId, room.roomKey, {
      ...(cursor !== undefined ? { cursor } : {}),
      threadId: flagValue(a, "--thread") ?? undefined,
      addressedTo: addressedTo === "me" ? "me" : undefined,
      presenceId: me.presence_id,
      timeoutMs: timeoutSeconds * 1000,
    });
    if (typeof result.cursor === "string") {
      updateRoomState(room.orgId, room.roomKey, { cursor: result.cursor });
    }
    console.log(JSON.stringify({
      messages: result.messages,
      cursor: result.cursor,
      has_more: result.has_more,
      settled: result.settled,
      waited_ms: result.waited_ms,
      live_presences: result.live_presences,
    }, null, 2));
    if (result.settled) {
      console.error(`${result.messages.length} message(s) arrived.`);
    } else {
      const live = result.live_presences ?? [];
      console.error(live.length > 0
        ? `silence — still live: ${live.map((p) => p.name).join(", ")}.`
        : "silence — nobody else is currently live in this room.");
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function get(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...ROOM_FLAGS, "--help", "-h"], ROOM_FLAGS);
  const positionals = positionalArgs(a, ROOM_FLAGS);
  requirePositionalCount(positionals, ROOM_FLAGS, {
    min: 1, max: 1, command: "run402 rooms get <message_id>", missing: "<message_id>",
  });
  const room = await resolveRoom({
    org: flagValue(a, "--org"), room: flagValue(a, "--room"), project: flagValue(a, "--project"),
  });
  try {
    console.log(JSON.stringify(await getSdk().rooms.getMessage(room.orgId, room.roomKey, positionals[0]), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function ack(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...ROOM_FLAGS, "--help", "-h"], ROOM_FLAGS);
  const positionals = positionalArgs(a, ROOM_FLAGS);
  requirePositionalCount(positionals, ROOM_FLAGS, {
    min: 1, max: 1, command: "run402 messages ack <message_id>", missing: "<message_id>",
  });
  const room = await resolveRoom({
    org: flagValue(a, "--org"), room: flagValue(a, "--room"), project: flagValue(a, "--project"),
  });
  try {
    const result = await withPresenceRetry(room.orgId, room.roomKey, (presenceId, sessionKey) =>
      getSdk().rooms.ackMessage(room.orgId, room.roomKey, positionals[0], {
        presenceId: presenceId ?? undefined,
        sessionKey,
      }));
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}


export async function run(sub, args) {
  const argv = Array.isArray(args) ? args : [];
  if (!sub || hasHelp([sub, ...argv])) {
    console.log(HELP);
    process.exit(0);
  }
  switch (sub) {
    case "send": {
      await send(argv);
      break;
    }
    case "list": {
      await list(argv);
      break;
    }
    case "wait": {
      await wait(argv);
      break;
    }
    case "get": {
      await get(argv);
      break;
    }
    case "ack": {
      await ack(argv);
      break;
    }
    default:
      failUnknownSubcommand("messages", sub, {
        hint: "Run `run402 messages --help` for usage.",
      });
  }
}
