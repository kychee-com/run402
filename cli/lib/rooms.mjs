/**
 * `run402 rooms` — the coordination room itself: arriving, leaving, and who is
 * in it.
 *
 * The MESSAGES exchanged in a room are `run402 messages` (legible-cli-surface).
 * Four of this family's five verbs used to act on a message, which made the
 * container the noun and left the thing you handle without one.
 *
 * `who` is now `join`: it REGISTERS a presence, and an interrogative must not
 * name a write.
 *
 * Gateway subsystem: add-agent-messaging (/orgs/v1/:org_id/rooms/:room_key/*).
 * Session presence cache: ./.run402/messaging.json (gitignore).
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

const HELP = `run402 rooms — arrive in a room, see who is live, leave when done

Usage:
  run402 rooms join [--name <name>] [--task <text>]

Addressing:
  --project <id>    That project's DEFAULT room (the room key IS the project id)
  --org <id> --room <key>   A named org room
  (omit both)       Resolved from RUN402_ROOM, a .run402.json binding, or the
                    wallet profile's selected org

Notes:
  - join registers this session's presence and returns who else is live, what
    they are working on, and what they have claimed — the arrive-and-look call.
  - Presence expires after ~1h of silence. Releasing it early (\`rooms leave\`),
    enumerating reachable rooms, and inspecting one are not here yet — each
    needs a gateway route that does not exist. Filed as follow-ups.
  - The messages themselves are \`run402 messages\`.
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
      org_source: room.orgSource ?? null,
      org_source_detail: room.orgSourceDetail ?? null,
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

export async function run(sub, args) {
  const argv = Array.isArray(args) ? args : [];
  if (!sub || hasHelp([sub, ...argv])) {
    console.log(HELP);
    process.exit(0);
  }
  switch (sub) {
    case "join": {
      await who(argv);
      break;
    }
    // `list`, `get` and `leave` are NOT here. Each needs a gateway route that
    // does not exist (there is no list-rooms, get-room, or release-presence
    // endpoint), and this change states plainly that it adds none. They are
    // filed as follow-ups rather than shipped as a CLI calling into nothing.
    //
    // `rooms list` and `rooms get` additionally carry design D3b: they are
    // FREED by the move of the message verbs, and a freed spelling stays dead
    // for one major before anything reuses it — a spelling that silently
    // answers with different data is worse than one that fails.
    // Retired here, and NOT aliased (design D3): each answers with its
    // successor so one failed call teaches the new model, where an alias
    // would teach the old one forever.
    case "who":
      fail({
        code: "COMMAND_REMOVED",
        message: "`run402 rooms who` was renamed to `run402 rooms join`.",
        hint: "run402 rooms join --name <name> --task <text>",
        details: { was: "rooms who", now: "rooms join", why: "an interrogative must not name a write — it registers a presence" },
      });
      break;
    case "list":
    case "get":
    case "send":
    case "ack":
      fail({
        code: "COMMAND_REMOVED",
        message: `\`run402 rooms ${sub}\` moved to \`run402 messages ${sub}\`.`,
        hint: `run402 messages ${sub}`,
        details: {
          was: `rooms ${sub}`,
          now: `messages ${sub}`,
          why: "the verb acts on a message, not on the room that contains it",
        },
      });
      break;
    default:
      failUnknownSubcommand("rooms", sub, {
        hint: "Run `run402 rooms --help` for usage.",
      });
  }
}
