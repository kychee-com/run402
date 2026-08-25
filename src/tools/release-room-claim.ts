import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { resolveRoomArgs } from "./rooms-shared.js";

export const releaseRoomClaimSchema = {
  project_id: z.string().optional().describe("Project whose default room the claim is in. Omit when passing org_id + room_key."),
  org_id: z.string().optional().describe("Org id (with room_key) for a named org room."),
  room_key: z.string().optional().describe("Named room slug (with org_id). Omit every addressing parameter to use the checkout's own context: RUN402_ROOM, or an `org`/`room` binding in .run402.json, or the wallet profile's selected org (read from the MCP server's working directory)."),
  claim_id: z.string().describe("The claim to release (clm_...). Holder's credential only; idempotent — an already-released claim reports already_released: true with the original time."),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleReleaseRoomClaim(args: {
  project_id?: string;
  org_id?: string;
  room_key?: string;
  claim_id: string;
}): Promise<McpResult> {
  const addr = await resolveRoomArgs(args).catch(() => null);
  if (!addr || !addr.ok) {
    const text = addr ? addr.error : "Could not resolve the room — check project_id / org_id + room_key.";
    return { content: [{ type: "text", text }], isError: true };
  }
  const room = addr.room;
  try {
    const result = await getSdk().rooms.releaseClaim(room.orgId, room.roomKey, args.claim_id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "releasing a room claim");
  }
}
