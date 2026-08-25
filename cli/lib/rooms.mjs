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
import { resolveTaskLabel } from "./harness-context.mjs";

export const IMPORTANCE = ["normal", "high"];

const ROOM_FLAGS = ["--project", "--org", "--room"];

const HELP = `run402 rooms — arrive in a room, see who is live, leave when done

Usage:
  run402 rooms join [--name <name>] [--task <text>]
  run402 rooms leave [<presence_id>]

Addressing:
  --project <id>    That project's DEFAULT room (the room key IS the project id)
  --org <id> --room <key>   A named org room
  (omit both)       Resolved from RUN402_ROOM, a .run402.json binding, or the
                    wallet profile's selected org

Notes:
  - join registers this session's presence and returns who else is live, what
    they are working on, and what they have claimed — the arrive-and-look call.
  - A quiet session's presence now resumes automatically across an idle gap
    or a lost local cache: join derives a stable session identity from your
    harness (Claude Code's own session id, Codex's own thread id, or a
    generated key persisted in ./.run402/) and the gateway revives the same
    presence under the same name no matter how long it was silent — the ~1h
    TTL only decays liveness, never that binding. Override with
    RUN402_SESSION_KEY. Two genuinely concurrent sessions never resume each
    other's presence.
  - --task is worth passing even without a name collision: on a taken name
    it now qualifies your name from your task instead of a bare counter
    (Opus taken + --task "mpp triage" -> Opus-mpp-triage, not Opus-2), and
    the output says why. Omit --task and join best-effort fills it from your
    harness's own thread title (Claude Code or Codex) — set
    RUN402_NO_TASK_FROM_TITLE=1 to opt out.
  - leave gives up THIS session's seat: its presence stops reading as live and
    its claims stop being held by a live session. Takes no argument — it uses
    the presence this checkout cached when it joined. Pass a \`prs_…\` only to
    release a specific one. Idempotent: a presence already gone (or belonging
    to someone else) reports left:false rather than failing, so a retry after
    a crash is safe.
  - Presence otherwise expires after ~1h of silence, which is why leaving
    matters: without it a finished session keeps holding its claims for the
    rest of that hour.
  - Enumerating reachable rooms and inspecting one are available on the API
    and in the SDK (\`rooms.list\` / \`rooms.get\`) but NOT yet as CLI
    spellings: \`rooms list\` and \`rooms get\` currently answer with their
    message successors, and a spelling that changes meaning never fails. They
    wait one major.
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
    const { task } = await resolveTaskLabel({ explicitTask: flagValue(a, "--task") });
    const me = await ensurePresence(room, { name: flagValue(a, "--name"), task });
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
    if (me.registered && me.resumed) {
      console.error(`Welcome back — resumed as ${me.name}.`);
    } else if (me.registered && me.renamed) {
      console.error(me.why ?? `You are ${me.name} — ${me.requested_name} was taken.`);
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function leave(argv) {
  const args = normalizeArgv(argv);
  assertKnownFlags("rooms leave", args, ROOM_FLAGS);
  const positionals = positionalArgs(args);
  requirePositionalCount("rooms leave", positionals, 0, 1, "[<presence_id>]");
  const room = await resolveRoom({
    org: flagValue(args, "--org"),
    room: flagValue(args, "--room"),
    project: flagValue(args, "--project"),
  });

  // No argument is the normal case: a session that is DONE knows which seat
  // is its own, and asking it to name one would be asking it to look up a
  // thing it already told us at join.
  const cached = cachedPresenceId(room.orgId, room.roomKey);
  const presenceId = positionals[0] ?? cached;
  if (!presenceId) {
    fail({
      code: "NO_PRESENCE",
      message: "No presence to leave — this checkout has not joined that room.",
      hint: "run402 rooms join",
      details: { org_id: room.orgId, room_key: room.roomKey },
    });
  }

  try {
    const result = await getSdk().rooms.leave(room.orgId, room.roomKey, presenceId);
    // Only forget the cached id when the one we released WAS it. An explicit
    // id that turned out to be someone else's must not evict this session's
    // own seat from the cache as a side effect.
    if (result.left && presenceId === cached) {
      updateRoomState(room.orgId, room.roomKey, { presence_id: null });
    }
    console.log(JSON.stringify({
      org_id: room.orgId,
      room_key: room.roomKey,
      presence_id: presenceId,
      left: result.left,
    }, null, 2));
    if (!result.left) {
      // Truthful, not alarming: expiry racing release is the normal shape.
      console.error("Nothing to release — that presence had already expired or was not yours.");
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
    case "leave": {
      await leave(argv);
      break;
    }
    // `list` and `get` are NOT here, and this is deliberate rather than
    // missing: the ROUTES exist (agent-room-lifecycle) and the SDK exposes
    // them as `rooms.list` / `rooms.get`. These two SPELLINGS were freed
    // hours ago by the move of the message verbs, and a freed spelling stays
    // dead for one major before anything reuses it (design D3b). Reissuing
    // them now with room semantics would never fail — an agent holding
    // `rooms list` would get a successful response containing different data
    // and nothing would tell it the world moved.
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
