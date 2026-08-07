/**
 * Shared room addressing + session presence for the agent-messaging MCP tools.
 *
 * Every rooms tool addresses a room the same way: project_id (that project's
 * DEFAULT room — the zero-config path) OR org_id + room_key (named org rooms).
 * The MCP server is a long-lived process, so the session's presence per room
 * lives in an in-memory map — tool calls after the first reuse it, and the
 * gateway's resolve-or-create converges to the same presence even after a
 * restart (same principal), so the cache is an optimization, not a correctness
 * requirement.
 */
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

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

export async function resolveRoomArgs(args: RoomAddressArgs): Promise<RoomAddressResult> {
  const hasProject = typeof args.project_id === "string" && args.project_id.length > 0;
  const hasOrg = typeof args.org_id === "string" && args.org_id.length > 0;
  const hasRoom = typeof args.room_key === "string" && args.room_key.length > 0;
  if (hasProject && (hasOrg || hasRoom)) {
    return { ok: false, error: "Pass either project_id (the project's default room) or org_id + room_key (a named org room) — not both." };
  }
  if (hasRoom !== hasOrg) {
    return { ok: false, error: "org_id and room_key go together — a named room is addressed as org_id + room_key. For a project's default room pass project_id alone." };
  }
  if (hasOrg && hasRoom) {
    return { ok: true, room: { orgId: args.org_id!, roomKey: args.room_key! } };
  }
  if (!hasProject) {
    return { ok: false, error: "Address the room: project_id for the project's default room, or org_id + room_key for a named org room." };
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

const roomKeyOf = (room: ResolvedRoom): string => `${room.orgId}/${room.roomKey}`;

export function cachedPresenceId(room: ResolvedRoom): string | undefined {
  const env = (process.env.RUN402_PRESENCE_ID ?? "").trim();
  if (env) return env;
  return presenceByRoom.get(roomKeyOf(room));
}

export function rememberPresence(room: ResolvedRoom, presence: unknown): void {
  const id = (presence as { presence_id?: unknown } | null | undefined)?.presence_id;
  if (typeof id === "string" && id) presenceByRoom.set(roomKeyOf(room), id);
}

export function forgetPresence(room: ResolvedRoom): void {
  presenceByRoom.delete(roomKeyOf(room));
}

/** Retry-once on PRESENCE_EXPIRED: drop the cached session presence and let
 *  the gateway's resolve-or-create mint a fresh one. */
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
      return call(undefined);
    }
    throw err;
  }
}
