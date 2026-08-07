import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { resolveRoomArgs, cachedPresenceId } from "./rooms-shared.js";

export const readRoomMessagesSchema = {
  project_id: z.string().optional().describe("Project whose default room to read. Omit when passing org_id + room_key."),
  org_id: z.string().optional().describe("Org id (with room_key) for a named org room."),
  room_key: z.string().optional().describe("Named room slug (with org_id)."),
  message_id: z.string().optional().describe("Fetch ONE message with its FULL body (lists carry snippets). When set, every other filter is ignored."),
  cursor: z.string().optional().describe("Opaque resume cursor (mcr_...) from a prior page. Store and echo — never parse. A stale cursor returns reset: true + earliest_cursor instead of an error."),
  unread: z.boolean().optional().describe("Only messages addressed to this session's presence that are newer than its read watermark. Requires having joined (or sent) at least once."),
  thread_id: z.string().optional().describe("Only one conversation thread."),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50, max 200)."),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleReadRoomMessages(args: {
  project_id?: string;
  org_id?: string;
  room_key?: string;
  message_id?: string;
  cursor?: string;
  unread?: boolean;
  thread_id?: string;
  limit?: number;
}): Promise<McpResult> {
  const addr = await resolveRoomArgs(args).catch(() => null);
  if (!addr || !addr.ok) {
    const text = addr ? addr.error : "Could not resolve the room — check project_id / org_id + room_key.";
    return { content: [{ type: "text", text }], isError: true };
  }
  const room = addr.room;
  try {
    const sdk = getSdk();
    if (args.message_id !== undefined) {
      const message = await sdk.rooms.getMessage(room.orgId, room.roomKey, args.message_id);
      return { content: [{ type: "text", text: JSON.stringify(message, null, 2) }] };
    }
    const presenceId = cachedPresenceId(room);
    const page = await sdk.rooms.listMessages(room.orgId, room.roomKey, {
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      ...(args.thread_id !== undefined ? { threadId: args.thread_id } : {}),
      ...(args.unread ? { addressedTo: "me" as const, unread: true } : {}),
      ...(presenceId !== undefined ? { presenceId } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
    return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "reading room messages");
  }
}
