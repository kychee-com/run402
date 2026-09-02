import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { resolveRoomArgs, cachedPresenceId, rememberPresence } from "./rooms-shared.js";
import { getSessionKey, resolveTaskLabel, resolveHarnessLabels } from "../harness-context.js";

export const joinRoomSchema = {
  project_id: z.string().optional().describe("Project whose DEFAULT room to join (the room key is the project id — the zero-config rendezvous). Omit when passing org_id + room_key."),
  org_id: z.string().optional().describe("Org id, together with room_key, to join a NAMED org room (multi-repo products)."),
  room_key: z.string().optional().describe("Named room slug (with org_id). Rooms auto-vivify on first use — there is no create call. Omit every addressing parameter to use the checkout's own context: RUN402_ROOM, or an `org`/`room` binding in .run402.json, or the wallet profile's selected org (read from the MCP server's working directory)."),
  requested_name: z.string().optional().describe("Choose your own presence name. Honored when free; on collision a task-derived name is tried first (Opus + task \"mpp triage\" -> Opus-mpp-triage) before a bare ordinal (Opus -> Opus-2) — the response reports requested_name + renamed + why, never an error. Ignored when this session resumes an existing presence (see the resumed field): an existing presence keeps its existing name."),
  task: z.string().optional().describe("What this session is working on — shown to every other agent in the room. Omit to best-effort auto-source it from your harness's own thread title (RUN402_NO_TASK_FROM_TITLE=1 opts out)."),
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
      // No in-memory presence yet for this room — the common case on a freshly
      // started server. sessionKey lets the gateway resume the SAME presence
      // this process (or an earlier instance of it) registered before, rather
      // than always registering fresh on every server restart.
      const { task } = await resolveTaskLabel({ explicitTask: args.task });
      // kygit-invite design D8: every registration carries harness-derived
      // labels — never guessed, null stays null.
      const { program, model } = resolveHarnessLabels();
      const registration = await sdk.rooms.registerPresence(room.orgId, room.roomKey, {
        ...(args.requested_name !== undefined ? { requestedName: args.requested_name } : {}),
        ...(task !== null ? { task } : {}),
        ...(program !== null ? { program } : {}),
        ...(model !== null ? { model } : {}),
        sessionKey: getSessionKey().key,
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
