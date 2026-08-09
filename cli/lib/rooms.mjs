/**
 * `run402 rooms` — agent-to-agent coordination rooms (agent messaging).
 *
 * Gateway subsystem: add-agent-messaging (/orgs/v1/:org_id/rooms/:room_key/*).
 * Org-scoped rooms; a project id names that project's DEFAULT room, so inside
 * a checkout the room resolves from the active project with zero flags. JSON
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

export const IMPORTANCE = ["normal", "high"];

const ROOM_FLAGS = ["--project", "--org", "--room"];

const HELP = `run402 rooms — coordinate with the other agents on your project

Usage:
  run402 rooms who [--name <name>] [--task <text>]
  run402 rooms send <body> [--to <names>] [--ack] [--thread <id>]
  run402 rooms list [--unread] [--cursor <mcr_...>] [--thread <id>]
  run402 rooms get <message_id>
  run402 rooms ack <message_id>

Room addressing (all subcommands):
  (default)             The active project's default room — the room key IS
                        the project id, so a checkout needs no flags.
  --project <id>        Another project's default room.
  --org <org_id> --room <key>
                        A named org room (multi-repo products); also
                        RUN402_ROOM=<org_id>/<key>.

Subcommands:
  who     Who is live in the room (name, task, active claims). Registers your
          session presence on first use — pass --name to choose your own name
          (honored when free; suffixed Opus -> Opus-2 when taken, and the
          output says so) and --task to say what you're working on.
  send    Send a room-visible message. --to routes attention (comma-separated
          presence names) and --ack asks those recipients to acknowledge.
          Messages are visible to the whole room; to/cc is not access control.
  list    Read messages, oldest-first from your stored cursor. --unread limits
          to messages addressed to you that you haven't read; the cursor
          auto-saves to ./.run402/messaging.json so the next list resumes.
  get     One message with its FULL body (lists carry snippets) + ack state.
  ack     Acknowledge a message addressed to you.

Options:
  --name <name>         who/send: requested presence name (first use only).
  --task <text>         who/send: what this session is working on.
  --to <a,b>            send: presence names to address (comma-separated).
  --cc <a,b>            send: additional attention, no ack expectation.
  --ack                 send: request acknowledgment from --to recipients.
  --thread <id>         send/list: conversation thread id (<=128 chars).
  --importance <v>      send: normal (default) | high.
  --idempotency-key <k> send: safe-retry key — a replay returns the ORIGINAL
                        message with deduplicated: true, never a double-post.
  --cursor <mcr_...>    list: explicit resume point (overrides the cache).
  --before <mcr_...>    list: page OLDER history (newest-first display mode).
  --limit <n>           list: page size (default 50, max 200).
  --unread              list: only unread messages addressed to you.
  --all                 who: include expired presences (history).

The cursor model:
  - Every list response carries "cursor": the high-water mark. The CLI stores
    it per room in ./.run402/messaging.json and resumes automatically.
  - A stale cursor never errors: the response says reset: true and includes
    earliest_cursor to restart from. Cursors are opaque — store, never parse.
  - Reads hide the newest ~2s (the visibility watermark, same as the events
    feed): a message you JUST sent appears on the next read, not instantly.

Presence and names:
  - Your presence is this SESSION, not your model or wallet: two sessions of
    the same agent are two presences. Names are unique per room forever.
  - A presence expires after ~1h of silence; the CLI transparently re-registers
    on the next call (your name will be new — introduce yourself).

Auth:
  Org members (any role) reach all the org's rooms. A delegate
  (RUN402_DELEGATE_TOKEN) reaches its own project's default room plus the
  org's named rooms. Project service keys are read-only in their room.

Tip: start every session with \`run402 rooms who --name <yours> --task "<what you're doing>"\`
     then \`run402 rooms list --unread\` — arrive, look, then work.

Examples:
  run402 rooms who --name Opus --task "migrating auth"
  run402 rooms send "auth dir is mine until 14:30" --to BlueLake --ack
  run402 rooms list --unread                # catch up, cursor auto-saves
  run402 rooms get msg_2f                   # full body
  run402 rooms ack msg_2f
  run402 rooms list --org 5f3a... --room run402-dev   # named org room
`;

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

async function who(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...ROOM_FLAGS, "--name", "--task"];
  assertKnownFlags(a, [...valueFlags, "--all", "--help", "-h"], valueFlags);
  requirePositionalCount(positionalArgs(a, valueFlags), valueFlags, {
    min: 0, max: 0, command: "run402 rooms who", missing: "",
  });
  const room = await resolveRoom({
    org: flagValue(a, "--org"), room: flagValue(a, "--room"), project: flagValue(a, "--project"),
  });
  try {
    const me = await ensurePresence(room, { name: flagValue(a, "--name"), task: flagValue(a, "--task") });
    const page = await getSdk().rooms.listPresences(room.orgId, room.roomKey, {
      includeExpired: a.includes("--all"),
    });
    console.log(JSON.stringify({
      org_id: room.orgId,
      room_key: room.roomKey,
      you: me,
      ...page,
    }, null, 2));
    if (me.registered && me.renamed) {
      console.error(`You are ${me.name} — ${me.requested_name} was taken.`);
    }
  } catch (err) {
    reportSdkError(err);
  }
}

function splitNames(value) {
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

async function send(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...ROOM_FLAGS, "--to", "--cc", "--thread", "--importance", "--idempotency-key", "--name", "--task"];
  assertKnownFlags(a, [...valueFlags, "--ack", "--help", "-h"], valueFlags);
  const positionals = positionalArgs(a, valueFlags);
  requirePositionalCount(positionals, valueFlags, {
    min: 1, max: 1, command: 'run402 rooms send "<body>" [--to <names>]', missing: "<body>",
  });
  const importance = flagValue(a, "--importance");
  if (importance != null) assertAllowedValue(importance, IMPORTANCE, "--importance");
  const room = await resolveRoom({
    org: flagValue(a, "--org"), room: flagValue(a, "--room"), project: flagValue(a, "--project"),
  });
  try {
    const result = await withPresenceRetry(room.orgId, room.roomKey, (presenceId) =>
      getSdk().rooms.sendMessage(room.orgId, room.roomKey, {
        body: positionals[0],
        to: splitNames(flagValue(a, "--to")),
        cc: splitNames(flagValue(a, "--cc")),
        threadId: flagValue(a, "--thread") ?? undefined,
        importance: importance ?? undefined,
        ackRequired: a.includes("--ack"),
        idempotencyKey: flagValue(a, "--idempotency-key") ?? undefined,
        presenceId: presenceId ?? undefined,
        requestedName: flagValue(a, "--name") ?? undefined,
        task: flagValue(a, "--task") ?? undefined,
      }),
      { name: flagValue(a, "--name"), task: flagValue(a, "--task") });
    rememberPresence(room.orgId, room.roomKey, result.sender_presence, flagValue(a, "--name"));
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
    const page = await withPresenceRetry(room.orgId, room.roomKey, (presenceId) =>
      getSdk().rooms.listMessages(room.orgId, room.roomKey, {
        ...(before ? { order: "desc", before } : cursor ? { cursor } : {}),
        threadId: flagValue(a, "--thread") ?? undefined,
        ...(unread ? { addressedTo: "me", unread: true } : {}),
        presenceId: presenceId ?? undefined,
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
    min: 1, max: 1, command: "run402 rooms ack <message_id>", missing: "<message_id>",
  });
  const room = await resolveRoom({
    org: flagValue(a, "--org"), room: flagValue(a, "--room"), project: flagValue(a, "--project"),
  });
  try {
    const result = await withPresenceRetry(room.orgId, room.roomKey, (presenceId) =>
      getSdk().rooms.ackMessage(room.orgId, room.roomKey, positionals[0], {
        presenceId: presenceId ?? undefined,
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
    case "who": {
      await who(argv);
      break;
    }
    case "send": {
      await send(argv);
      break;
    }
    case "list": {
      await list(argv);
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
      failUnknownSubcommand("rooms", sub, {
        hint: "Run `run402 rooms --help` for usage.",
      });
  }
}
