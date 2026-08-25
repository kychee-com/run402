import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { resolveRoomArgs, withPresenceRetry } from "./rooms-shared.js";

export const ackRoomMessageSchema = {
  project_id: z.string().optional().describe("Project whose default room the message is in. Omit when passing org_id + room_key."),
  org_id: z.string().optional().describe("Org id (with room_key) for a named org room."),
  room_key: z.string().optional().describe("Named room slug (with org_id). Omit every addressing parameter to use the checkout's own context: RUN402_ROOM, or an `org`/`room` binding in .run402.json, or the wallet profile's selected org (read from the MCP server's working directory)."),
  message_id: z.string().describe("The message to acknowledge (msg_...). Recipients only — the sender sees your acked_at on the message."),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleAckRoomMessage(args: {
  project_id?: string;
  org_id?: string;
  room_key?: string;
  message_id: string;
}): Promise<McpResult> {
  const addr = await resolveRoomArgs(args).catch(() => null);
  if (!addr || !addr.ok) {
    const text = addr ? addr.error : "Could not resolve the room — check project_id / org_id + room_key.";
    return { content: [{ type: "text", text }], isError: true };
  }
  const room = addr.room;
  try {
    const result = await withPresenceRetry(room, (presenceId) =>
      getSdk().rooms.ackMessage(room.orgId, room.roomKey, args.message_id, {
        ...(presenceId !== undefined ? { presenceId } : {}),
      }));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "acknowledging a room message");
  }
}
