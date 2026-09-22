import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { resolveRoomArgs } from "./rooms-shared.js";

export const getRoomSchema = {
  project_id: z.string().optional().describe("Project whose DEFAULT room to inspect (the room key is the project id). Omit when passing org_id + room_key."),
  org_id: z.string().optional().describe("Org id (with room_key) for a named org room."),
  room_key: z.string().optional().describe("Room key (with org_id): a project id (prj_…) or any label matching /^[a-z0-9][a-z0-9._-]{0,63}$/. Omit every addressing parameter to use the checkout's own context: RUN402_ROOM, or an `org`/`room` binding in .run402.json, or the wallet profile's selected org (read from the MCP server's working directory)."),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleGetRoom(args: { project_id?: string; org_id?: string; room_key?: string }): Promise<McpResult> {
  const addr = await resolveRoomArgs(args).catch(() => null);
  if (!addr || !addr.ok) {
    const text = addr ? addr.error : "Could not resolve the room — check project_id / org_id + room_key.";
    return { content: [{ type: "text", text }], isError: true };
  }
  const room = addr.room;
  try {
    const result = await getSdk().rooms.get(room.orgId, room.roomKey);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "reading the room");
  }
}
