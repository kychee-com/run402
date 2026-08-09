import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { resolveRoomArgs, cachedPresenceId, rememberPresence } from "./rooms-shared.js";

export const joinRoomSchema = {
  project_id: z.string().optional().describe("Project whose DEFAULT room to join (the room key is the project id — the zero-config rendezvous). Omit when passing org_id + room_key."),
  org_id: z.string().optional().describe("Org id, together with room_key, to join a NAMED org room (multi-repo products)."),
  room_key: z.string().optional().describe("Named room slug (with org_id). Rooms auto-vivify on first use — there is no create call."),
  requested_name: z.string().optional().describe("Choose your own presence name. Honored when free; suffixed on collision (Opus -> Opus-2) — the response reports requested_name + renamed, never an error."),
  task: z.string().optional().describe("What this session is working on — shown to every other agent in the room."),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleJoinRoom(args: {
  project_id?: string;
  org_id?: string;
  room_key?: string;
  requested_name?: string;
  task?: string;
}): Promise<McpResult> {
  const addr = await resolveRoomArgs(args).catch((err) => ({ ok: false as const, error: mapSdkErrorText(err) }));
  if (!addr.ok) return { content: [{ type: "text", text: addr.error }], isError: true };
  const room = addr.room;
  try {
    const sdk = getSdk();
    let you: unknown = null;
    const existing = cachedPresenceId(room);
    if (existing) {
      you = { presence_id: existing, reused: true };
    } else {
      const registration = await sdk.rooms.registerPresence(room.orgId, room.roomKey, {
        ...(args.requested_name !== undefined ? { requestedName: args.requested_name } : {}),
        ...(args.task !== undefined ? { task: args.task } : {}),
      });
      rememberPresence(room, registration, args.requested_name);
      you = registration;
    }
    const [presences, claims] = await Promise.all([
      sdk.rooms.listPresences(room.orgId, room.roomKey),
      sdk.rooms.listClaims(room.orgId, room.roomKey),
    ]);
    const arrival = { org_id: room.orgId, room_key: room.roomKey, you, ...presences, ...claims };
    return { content: [{ type: "text", text: JSON.stringify(arrival, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "joining the coordination room");
  }
}

function mapSdkErrorText(err: unknown): string {
  const mapped = mapSdkError(err, "resolving the room");
  return mapped.content[0]?.text ?? String(err);
}
