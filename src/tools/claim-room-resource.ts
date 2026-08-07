import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { resolveRoomArgs, withPresenceRetry } from "./rooms-shared.js";

export const claimRoomResourceSchema = {
  project_id: z.string().optional().describe("Project whose default room to claim in. Omit when passing org_id + room_key."),
  org_id: z.string().optional().describe("Org id (with room_key) for a named org room."),
  room_key: z.string().optional().describe("Named room slug (with org_id)."),
  resource: z.string().describe("What you're working on: repo:<glob> (glob-overlap conflicts, e.g. repo:src/auth/**), function:<name>, table:<name>, deploy, or any free-form string (exact match)."),
  mode: z.enum(["exclusive", "shared"]).optional().describe("exclusive (default): one worker. shared: parallel-safe (only conflicts with an exclusive)."),
  ttl_seconds: z.number().int().min(1).max(86400).optional().describe("Lifetime (default 3600). Claims auto-expire so a dead session never wedges the room."),
  note: z.string().optional().describe("Why — shown to every agent that hits the conflict."),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleClaimRoomResource(args: {
  project_id?: string;
  org_id?: string;
  room_key?: string;
  resource: string;
  mode?: "exclusive" | "shared";
  ttl_seconds?: number;
  note?: string;
}): Promise<McpResult> {
  const addr = await resolveRoomArgs(args).catch(() => null);
  if (!addr || !addr.ok) {
    const text = addr ? addr.error : "Could not resolve the room — check project_id / org_id + room_key.";
    return { content: [{ type: "text", text }], isError: true };
  }
  const room = addr.room;
  try {
    const created = await withPresenceRetry(room, (presenceId) =>
      getSdk().rooms.createClaim(room.orgId, room.roomKey, {
        resource: args.resource,
        mode: args.mode ?? "exclusive",
        ...(args.ttl_seconds !== undefined ? { ttlSeconds: args.ttl_seconds } : {}),
        ...(args.note !== undefined ? { note: args.note } : {}),
        ...(presenceId !== undefined ? { presenceId } : {}),
      }));
    return { content: [{ type: "text", text: JSON.stringify(created, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "claiming a room resource");
  }
}
