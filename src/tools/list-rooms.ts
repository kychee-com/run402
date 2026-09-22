import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { resolveRoomArgs } from "./rooms-shared.js";

export const listRoomsSchema = {
  org_id: z.string().optional().describe("Org whose rooms to enumerate. Omit to use the checkout's own context: RUN402_ROOM, an `org` binding in .run402.json, the wallet profile's selected org, or the org that owns project_id."),
  project_id: z.string().optional().describe("A project whose owning org's rooms to enumerate. Omit when passing org_id."),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleListRooms(args: { org_id?: string; project_id?: string }): Promise<McpResult> {
  let orgId = args.org_id?.trim() || undefined;
  if (!orgId) {
    // Any room address resolves to an org; the room half is not needed here.
    const addr = await resolveRoomArgs({ project_id: args.project_id }).catch(() => null);
    if (!addr || !addr.ok) {
      const text = addr ? addr.error : "Could not resolve the organization — pass org_id or project_id.";
      return { content: [{ type: "text", text }], isError: true };
    }
    orgId = addr.room.orgId;
  }
  try {
    const result = await getSdk().rooms.list(orgId);
    return { content: [{ type: "text", text: JSON.stringify({ org_id: orgId, ...result }, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "listing rooms");
  }
}
