/**
 * Shared room resolution + per-checkout session state for the agent-messaging
 * commands (`run402 messages`, `run402 claims`).
 *
 * Room addressing (precedence):
 *   --org <org_id> + --room <key>   explicit (named org rooms)
 *   RUN402_ROOM=<org_id>/<key>      env form of the same
 *   <room key> + the shared chain   a room key from --room or the binding
 *                                   file's `room`, with the ORG resolved by
 *                                   `org-context.mjs` — this is what reaches a
 *                                   named room in a checkout with no project
 *   (default)                       the project's DEFAULT room — the room key
 *                                   IS the project id; org resolved via the
 *                                   project overview (`rooms.forProject`).
 *
 * Session state lives at ./.run402/messaging.json (per-checkout — the house
 * discipline of one worktree per agent session makes per-checkout equal
 * per-session). It caches, per room: the session's presence_id, the granted
 * name, the name originally asked for, and the read cursor. Add `.run402/` to
 * .gitignore. Two sessions sharing one checkout share a presence (coherent,
 * just undifferentiated); RUN402_PRESENCE_ID overrides for harnesses that
 * multiplex. Carrying the presence_id is what makes a call "the same session":
 * the server never infers a session from the credential.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./sdk-errors.mjs";
import { getActiveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { resolveOrg } from "./org-context.mjs";
import { findBindingKey } from "./wallet-context.mjs";
import { nextAction } from "./next-actions.mjs";
import { resolveSessionKey } from "./harness-context.mjs";
import { describeRejectedValue } from "../core-dist/redact.js";

export const ROOM_ENV = "RUN402_ROOM";
export const PRESENCE_ENV = "RUN402_PRESENCE_ID";

const STATE_DIR = ".run402";
const STATE_FILE = "messaging.json";

/**
 * Resolve the addressed room to { orgId, roomKey } (one SDK lookup at most).
 *
 * A room is a PAIR, and this function owns the pair. What it no longer owns is
 * the org half of its own fallback: below the explicit forms, the org comes
 * from the shared chain in `org-context.mjs` (flag → env → binding → profile
 * selection → active project) while the room key comes from `--room`, the
 * binding file's `room` key, or the project's default room. That is what makes
 * a named room reachable in a checkout with no project link at all.
 */
export async function resolveRoom({ org, room, project } = {}) {
  // 1. Both halves named explicitly.
  if (org && room) return { orgId: org, roomKey: room, orgSource: "flag", orgSourceDetail: "--org" };

  // 2. The compound env form names both, and keeps outranking everything below
  //    it — a harness wired with RUN402_ROOM selects exactly the room it names.
  const envRoom = (process.env[ROOM_ENV] ?? "").trim();
  if (envRoom) {
    const slash = envRoom.indexOf("/");
    if (slash <= 0 || slash === envRoom.length - 1) {
      // Same class as kychee-com/run402-private#640: a malformed RUN402_ROOM
      // is a value we know nothing about, so it must not be echoed raw.
      fail({
        code: "BAD_USAGE",
        message: `${ROOM_ENV} must be "<org_id>/<room_key>".`,
        details: { value: describeRejectedValue(envRoom) },
      });
    }
    return {
      orgId: envRoom.slice(0, slash),
      roomKey: envRoom.slice(slash + 1),
      orgSource: "env",
      orgSourceDetail: ROOM_ENV,
    };
  }

  // 3. A room key without an org: the org resolves through the shared chain.
  //    (`--room` alone works whenever the org resolves, and fails with
  //    ORG_REQUIRED — naming every way to supply one — when it does not.)
  const bindingRoom = findBindingKey(process.cwd(), "room");
  const roomKey = room ?? bindingRoom?.value ?? null;
  if (roomKey) {
    const resolved = await resolveOrg({ org, project }, { cmd: "rooms" });
    return {
      orgId: resolved.orgId,
      roomKey,
      orgSource: resolved.source,
      orgSourceDetail: resolved.sourceDetail,
    };
  }

  // 4. No room key anywhere: the project's DEFAULT room, whose key IS the
  //    project id — the zero-config rendezvous carried by run402.config.json.
  const effectiveProject = project || (process.env.RUN402_PROJECT_ID ?? "").trim() || getActiveProjectId();
  if (!effectiveProject) {
    fail({
      code: "ROOM_REQUIRED",
      message: "No room addressed and no current project to take a default room from.",
      hint: `Pass --org <org_id> --room <key>, set ${ROOM_ENV}="<org_id>/<room_key>", add a "room" key to .run402.json, or select a project with: run402 projects use <project_id>`,
      next_actions: [
        nextAction("edit_request", {
          command: "run402 rooms join --org <org_id> --room <key>",
          why: "Name the organization and room on this one call.",
        }),
        nextAction("edit_request", {
          command: `echo '{"org":"<org_id>","room":"<key>"}' > .run402.json`,
          why: "Bind this checkout so every agent in it lands in the same room with no flags.",
        }),
        nextAction("edit_request", {
          command: "run402 projects use <project_id>",
          why: "Select a project to use its default room (the room key IS the project id).",
        }),
      ],
    });
  }
  const scoped = await getSdk().rooms.forProject(effectiveProject);
  return {
    orgId: scoped.orgId,
    roomKey: scoped.roomKey,
    orgSource: "profile",
    orgSourceDetail: "projects use",
  };
}

function statePath() {
  return join(process.cwd(), STATE_DIR, STATE_FILE);
}

function loadState() {
  try {
    const raw = readFileSync(statePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && parsed.rooms && typeof parsed.rooms === "object"
      ? parsed
      : { rooms: {} };
  } catch {
    return { rooms: {} };
  }
}

function saveState(state) {
  try {
    const dir = join(process.cwd(), STATE_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // Best-effort cache: an unwritable checkout degrades to stateless calls.
  }
}

const roomStateKey = (orgId, roomKey) => `${orgId}/${roomKey}`;

export function getRoomState(orgId, roomKey) {
  return loadState().rooms[roomStateKey(orgId, roomKey)] ?? {};
}

export function updateRoomState(orgId, roomKey, patch) {
  const state = loadState();
  const key = roomStateKey(orgId, roomKey);
  state.rooms[key] = { ...(state.rooms[key] ?? {}), ...patch };
  saveState(state);
}

/** The session's presence id for a room: env override, else the checkout cache. */
export function cachedPresenceId(orgId, roomKey) {
  const env = (process.env[PRESENCE_ENV] ?? "").trim();
  if (env) return env;
  const cached = getRoomState(orgId, roomKey).presence_id;
  return typeof cached === "string" && cached ? cached : null;
}

/** The name this session originally asked for (so a replacement asks again). */
function cachedRequestedName(orgId, roomKey) {
  const cached = getRoomState(orgId, roomKey).requested_name;
  return typeof cached === "string" && cached ? cached : null;
}

/**
 * This process's session identity, resolved once and reused for every
 * coordination call the process makes (see harness-context.mjs — explicit
 * override, then the harness's own session id, then a locally generated and
 * persisted key). Memoized because `resolveSessionKey` touches the
 * filesystem on its slowest path and every caller in one invocation is
 * asking about the same session.
 */
let mySessionKeyMemo;
function mySessionKey() {
  if (mySessionKeyMemo === undefined) mySessionKeyMemo = resolveSessionKey().key;
  return mySessionKeyMemo;
}

/**
 * Register a NEW session presence and make it this checkout's presence.
 * `name` is the name to ask for — honored when free, honestly suffixed when
 * taken (names are never recycled, so a replacement for `Fable` becomes
 * `Fable-2`, and the caller is told). Carries this session's resolved
 * identity, so a session presenting the SAME key it used before RESUMES its
 * existing presence here instead of registering a stranger under a fresh
 * name — the response says `resumed: true` and `name`/`renamed`/`why` are
 * absent, because nothing about naming happened.
 */
export async function registerFreshPresence(orgId, roomKey, { name, task } = {}) {
  const requestedName = name ?? cachedRequestedName(orgId, roomKey);
  const registration = await getSdk().rooms.registerPresence(orgId, roomKey, {
    ...(requestedName ? { requestedName } : {}),
    ...(task ? { task } : {}),
    sessionKey: mySessionKey(),
  });
  rememberPresence(orgId, roomKey, registration, requestedName);
  return registration;
}

/**
 * Run a room call carrying this session's presence. Every call carries this
 * session's resolved identity ALONGSIDE any cached `presence_id` — the
 * gateway tries the session identity first, so a presence whose TTL lapsed
 * between calls REVIVES under its own name via that path rather than 410ing;
 * the retry below is now reached only when no resolvable session identity
 * exists (a harness this couldn't identify, RUN402_PRESENCE_ID pinned to a
 * stale id) or the presence aged past the 90-day retention sweep, not on an
 * ordinary hour of silence. On PRESENCE_EXPIRED (410) drop the cache,
 * REGISTER a replacement, and retry ONCE with it. The registration is
 * explicit on purpose: a bare call cannot mean "me" from the credential
 * alone, because the server cannot tell one credential's concurrent sessions
 * apart — it would either guess (adopting a sibling session's presence,
 * run402-private#663) or refuse. Asking — by session identity when we have
 * one, by explicit (re-)registration when we don't — is unambiguous.
 */
export async function withPresenceRetry(orgId, roomKey, call, { name, task } = {}) {
  const presenceId = cachedPresenceId(orgId, roomKey);
  const sessionKey = mySessionKey();
  try {
    return await call(presenceId, sessionKey);
  } catch (err) {
    const code = err?.body?.code ?? err?.code;
    if (code === "PRESENCE_EXPIRED" && presenceId) {
      updateRoomState(orgId, roomKey, { presence_id: null, name: null });
      const replacement = await registerFreshPresence(orgId, roomKey, { name, task });
      if (replacement?.renamed) {
        console.error(`Your presence expired; you are now ${replacement.name}.`);
      }
      return call(replacement?.presence_id ?? null, sessionKey);
    }
    throw err;
  }
}

/** Cache the presence a response attributed this session to. */
export function rememberPresence(orgId, roomKey, presence, requestedName) {
  if (!presence || typeof presence !== "object") return;
  const id = presence.presence_id;
  const name = presence.name;
  // The name ASKED FOR is remembered separately from the name granted: a
  // replacement presence should ask for `Fable` again (→ Fable-3), not for the
  // granted `Fable-2` (→ Fable-2-2).
  const asked = requestedName ?? presence.requested_name;
  if (typeof id === "string" && id) {
    updateRoomState(orgId, roomKey, {
      presence_id: id,
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof asked === "string" && asked ? { requested_name: asked } : {}),
    });
  }
}
