import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { resolveRoomArgs, rememberPresence, withPresenceRetry } from "./rooms-shared.js";

export const sendRoomMessageSchema = {
  project_id: z.string().optional().describe("Project whose default room to send in. Omit when passing org_id + room_key."),
  org_id: z.string().optional().describe("Org id (with room_key) for a named org room."),
  room_key: z.string().optional().describe("Named room slug (with org_id)."),
  body: z.string().describe("Markdown message body (<=32 KiB — over-cap is rejected, never truncated). Room-visible: every agent in the room can read it."),
  to: z.array(z.string()).optional().describe("Presence names to address. Attention routing, not access control — recipients see it in their unread filter and can be asked to ack."),
  cc: z.array(z.string()).optional().describe("Additional attention, no ack expectation."),
  thread_id: z.string().optional().describe("Conversation thread id (<=128 chars) — replies pass the same value."),
  importance: z.enum(["normal", "high"]).optional().describe("high floats to the top of unread reads."),
  ack_required: z.boolean().optional().describe("Ask the to[] recipients to acknowledge (their ack state is visible on the message)."),
  idempotency_key: z.string().optional().describe("Safe-retry key: a replay returns the ORIGINAL message with deduplicated: true — never a double-post."),
  requested_name: z.string().optional().describe("If this send auto-registers your presence (first coordination call), choose your name."),
  task: z.string().optional().describe("If this send auto-registers, what this session is working on."),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleSendRoomMessage(args: {
  project_id?: string;
  org_id?: string;
  room_key?: string;
  body: string;
  to?: string[];
  cc?: string[];
  thread_id?: string;
  importance?: "normal" | "high";
  ack_required?: boolean;
  idempotency_key?: string;
  requested_name?: string;
  task?: string;
}): Promise<McpResult> {
  const addr = await resolveRoomArgs(args).catch(() => null);
  if (!addr || !addr.ok) {
    const text = addr ? addr.error : "Could not resolve the room — check project_id / org_id + room_key.";
    return { content: [{ type: "text", text }], isError: true };
  }
  const room = addr.room;
  try {
    const result = await withPresenceRetry(room, (presenceId) =>
      getSdk().rooms.sendMessage(room.orgId, room.roomKey, {
        body: args.body,
        ...(args.to !== undefined ? { to: args.to } : {}),
        ...(args.cc !== undefined ? { cc: args.cc } : {}),
        ...(args.thread_id !== undefined ? { threadId: args.thread_id } : {}),
        ...(args.importance !== undefined ? { importance: args.importance } : {}),
        ...(args.ack_required !== undefined ? { ackRequired: args.ack_required } : {}),
        ...(args.idempotency_key !== undefined ? { idempotencyKey: args.idempotency_key } : {}),
        ...(presenceId !== undefined ? { presenceId } : {}),
        ...(args.requested_name !== undefined ? { requestedName: args.requested_name } : {}),
        ...(args.task !== undefined ? { task: args.task } : {}),
      }));
    rememberPresence(room, (result as { sender_presence?: unknown }).sender_presence);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "sending a room message");
  }
}
