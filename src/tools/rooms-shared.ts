/**
 * Shared room addressing + session presence for the agent-messaging MCP tools.
 *
 * Every rooms tool addresses a room the same way: project_id (that project's
 * DEFAULT room — the zero-config path) OR org_id + room_key (named org rooms)
 * OR, when neither is passed, the checkout's own ambient context — RUN402_ROOM,
 * or a `room`/`org` binding in .run402.json, or the wallet profile's selected
 * organization (run402-public#550). Both explicit forms outrank the ambient
 * chain, so a call that names a room still reaches exactly that room.
 * The MCP server is a long-lived process, so the session's presence per room
 * lives in an in-memory map — tool calls after the first reuse it. The cache is
 * what makes those calls ONE session: the gateway never infers a session from
 * the credential (a bare call registers a fresh presence rather than adopting a
 * sibling session's — run402-private#663), so a lost cache means a new presence
 * with a new, honestly-suffixed name, not silent reuse of an old one.
 */
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { findBindingKey } from "../../core/dist/binding-file.js";
import { getActiveOrgId } from "../../core/dist/profile-state.js";

export interface RoomAddressArgs {
  project_id?: string;
  org_id?: string;
  room_key?: string;
}

export interface ResolvedRoom {
  orgId: string;
  roomKey: string;
}

export type RoomAddressResult =
  | { ok: true; room: ResolvedRoom }
  | { ok: false; error: string };

const ORG_ENV = "RUN402_ORG";
const ROOM_ENV = "RUN402_ROOM";

const trimmed = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/**
 * Address a room from the ambient context, when nothing was passed explicitly.
 *
 * This mirrors the CLI's precedence (run402 4.27.0) but is a SEPARATE
 * implementation on purpose, for two reasons the CLI's version cannot satisfy:
 *
 *  1. The CLI resolver calls `fail()`, which is `process.exit(1)`. In a
 *     long-lived MCP server that turns "you didn't name an org" into a dead
 *     server for every subsequent tool call. Everything here RETURNS.
 *  2. `run402-mcp` ships `dist` + `core/dist` + `sdk/dist`; `cli/` is not in
 *     the published package, so the CLI's copy is not importable at runtime.
 *
 * What IS shared is the thing worth sharing — the binding-file reader and the
 * profile-state getter, both in core. Precedence is a short, explicit list
 * here rather than a second general resolver.
 *
 * The directory walked is the SERVER's working directory. An MCP server is
 * spawned once, typically in the checkout the agent is working in, and its cwd
 * does not follow the agent afterwards. That is the right default and a real
 * limit: a server spawned outside the checkout finds no binding and falls
 * through to the environment and the profile, which is a graceful miss rather
 * than a wrong room.
 */
function resolveAmbientRoom(cwd: string, env: NodeJS.ProcessEnv): RoomAddressResult | null {
  // The compound env form names both halves and outranks the rest — a harness
  // wired with RUN402_ROOM reaches exactly the room it names.
  const envRoom = trimmed(env[ROOM_ENV]);
  if (envRoom) {
    const slash = envRoom.indexOf("/");
    if (slash <= 0 || slash === envRoom.length - 1) {
      return { ok: false, error: `${ROOM_ENV} must be "<org_id>/<room_key>" — got ${JSON.stringify(envRoom)}.` };
    }
    return { ok: true, room: { orgId: envRoom.slice(0, slash), roomKey: envRoom.slice(slash + 1) } };
  }

  const bindingRoom = findBindingKey(cwd, "room");
  const roomKey = trimmed(bindingRoom?.value);
  if (!roomKey) return null; // No room key anywhere — the caller reports how to address one.

  // The org half, highest first: environment, then the checkout's binding,
  // then the wallet profile's selection.
  const envOrg = trimmed(env[ORG_ENV]);
  const bindingOrg = findBindingKey(cwd, "org");

  // An ambient variable disagreeing with a committed file is the surprise
  // worth stopping on — the CLI stops here too, and for the same reason. A
  // binding outranking the PROFILE stays silent; that is what a binding is for.
  if (envOrg && bindingOrg && envOrg !== bindingOrg.value) {
    return {
      ok: false,
      error: `Ambiguous organization: ${ORG_ENV}=${envOrg} but ${bindingOrg.file} binds ${bindingOrg.value}. `
        + "Pass org_id + room_key on this call, unset the variable, or edit the binding file.",
    };
  }

  const orgId = envOrg ?? trimmed(bindingOrg?.value) ?? trimmed(getActiveOrgId());
  if (!orgId) return null;
  return { ok: true, room: { orgId, roomKey } };
}

export async function resolveRoomArgs(
  args: RoomAddressArgs,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RoomAddressResult> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const hasProject = typeof args.project_id === "string" && args.project_id.length > 0;
  const hasOrg = typeof args.org_id === "string" && args.org_id.length > 0;
  const hasRoom = typeof args.room_key === "string" && args.room_key.length > 0;
  if (hasProject && (hasOrg || hasRoom)) {
    return { ok: false, error: "Pass either project_id (the project's default room) or org_id + room_key (a named org room) — not both." };
  }
  if (hasRoom !== hasOrg) {
    return { ok: false, error: "org_id and room_key go together — a named room is addressed as org_id + room_key. For a project's default room pass project_id alone." };
  }
  // Both explicit forms keep outranking the ambient chain, exactly as they do
  // in the CLI: a tool call that names a room reaches that room, always.
  if (hasOrg && hasRoom) {
    return { ok: true, room: { orgId: args.org_id!, roomKey: args.room_key! } };
  }
  if (!hasProject) {
    const ambient = resolveAmbientRoom(cwd, env);
    if (ambient) return ambient;
    return {
      ok: false,
      error: "Address the room: project_id for the project's default room, or org_id + room_key for a named org room. "
        + `This checkout can also bind one — \`{"org":"<org_id>","room":"<key>"}\` in .run402.json — or set ${ROOM_ENV}="<org_id>/<room_key>".`,
    };
  }
  try {
    const scoped = await getSdk().rooms.forProject(args.project_id!);
    return { ok: true, room: { orgId: scoped.orgId, roomKey: scoped.roomKey } };
  } catch (err) {
    // Surface the real SDK error (project not found, auth, network) instead of
    // a generic addressing hint — resolveRoomArgs never throws.
    const mapped = mapSdkError(err, "resolving the project's default room");
    return { ok: false, error: mapped.content[0]?.text ?? String(err) };
  }
}

const presenceByRoom = new Map<string, string>();
/** The name this session asked for, so a replacement presence asks again. */
const requestedNameByRoom = new Map<string, string>();

const roomKeyOf = (room: ResolvedRoom): string => `${room.orgId}/${room.roomKey}`;

export function cachedPresenceId(room: ResolvedRoom): string | undefined {
  const env = (process.env.RUN402_PRESENCE_ID ?? "").trim();
  if (env) return env;
  return presenceByRoom.get(roomKeyOf(room));
}

export function rememberPresence(room: ResolvedRoom, presence: unknown, requestedName?: string): void {
  const id = (presence as { presence_id?: unknown } | null | undefined)?.presence_id;
  if (typeof id === "string" && id) presenceByRoom.set(roomKeyOf(room), id);
  // Remember the name ASKED FOR, not the one granted: a replacement should ask
  // for `Opus` again (-> Opus-3), never for the granted `Opus-2` (-> Opus-2-2).
  const asked = requestedName ?? (presence as { requested_name?: unknown } | null | undefined)?.requested_name;
  if (typeof asked === "string" && asked) requestedNameByRoom.set(roomKeyOf(room), asked);
}

export function forgetPresence(room: ResolvedRoom): void {
  presenceByRoom.delete(roomKeyOf(room));
}

/** Retry-once on PRESENCE_EXPIRED: drop the cached session presence, REGISTER
 *  a replacement (asking for the same name — it suffixes honestly), and retry
 *  with it. Registration is explicit because a bare call cannot mean "me". */
export async function withPresenceRetry<T>(
  room: ResolvedRoom,
  call: (presenceId: string | undefined) => Promise<T>,
): Promise<T> {
  const presenceId = cachedPresenceId(room);
  try {
    return await call(presenceId);
  } catch (err) {
    const code = (err as { body?: { code?: string }; code?: string })?.body?.code
      ?? (err as { code?: string })?.code;
    if (code === "PRESENCE_EXPIRED" && presenceId) {
      forgetPresence(room);
      const requestedName = requestedNameByRoom.get(roomKeyOf(room));
      const replacement = await getSdk().rooms.registerPresence(room.orgId, room.roomKey, {
        ...(requestedName ? { requestedName } : {}),
      });
      rememberPresence(room, replacement, requestedName);
      return call(replacement?.presence_id);
    }
    throw err;
  }
}
