import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { resolveRoomArgs, cachedPresenceId, forgetPresence } from "./rooms-shared.js";

export const leaveRoomSchema = {
  project_id: z.string().optional().describe("Project whose DEFAULT room to leave. Omit when passing org_id + room_key."),
  org_id: z.string().optional().describe("Org id (with room_key) for a named org room."),
  room_key: z.string().optional().describe("Room key (with org_id). Omit every addressing parameter to use the checkout's own context: RUN402_ROOM, or an `org`/`room` binding in .run402.json, or the wallet profile's selected org (read from the MCP server's working directory)."),
  presence_id: z.string().optional().describe("The presence to release (prs_...). Omit to release the presence this server registered when it joined the room. Scoped to your PRINCIPAL: another principal's presence is never touched, but one of your OWN other sessions' presences can be released — how a fresh session clears a crashed predecessor."),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleLeaveRoom(args: {
  project_id?: string;
  org_id?: string;
  room_key?: string;
  presence_id?: string;
}): Promise<McpResult> {
  const addr = await resolveRoomArgs(args).catch(() => null);
  if (!addr || !addr.ok) {
    const text = addr ? addr.error : "Could not resolve the room — check project_id / org_id + room_key.";
    return { content: [{ type: "text", text }], isError: true };
  }
  const room = addr.room;
  const cached = cachedPresenceId(room);
  const presenceId = args.presence_id?.trim() || cached;
  if (!presenceId) {
    return {
      content: [{ type: "text", text: "No presence to leave — this server has not joined that room. Pass presence_id to release a specific presence, or join_room first." }],
      isError: true,
    };
  }
  try {
    const result = await getSdk().rooms.leave(room.orgId, room.roomKey, presenceId);
    // Only forget the cached id when the one released WAS it — an explicit
    // id that turned out to be someone else's must not evict this session's
    // own presence from the cache as a side effect.
    if (result.left && presenceId === cached) forgetPresence(room);
    const out = { org_id: room.orgId, room_key: room.roomKey, presence_id: presenceId, left: result.left };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "leaving the room");
  }
}
