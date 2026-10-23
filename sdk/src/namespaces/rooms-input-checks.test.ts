/**
 * Every rooms input check throws a LocalError with a specific code and one
 * `edit_request` next action naming the expected field, before any request.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402, isLocalError } from "../index.js";
import type { CredentialsProvider } from "../credentials.js";

const ORG = "00000000-0000-0000-0000-aaaaaaaaaaaa";

function makeSdk(): { r: Run402; calls: string[] } {
  const calls: string[] = [];
  const creds: CredentialsProvider = {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject() {
      return null;
    },
  };
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { r: new Run402({ apiBase: "https://api.example.test", credentials: creds, fetch: fetchImpl }), calls };
}

const cases: Array<[string, string, string, (r: Run402) => unknown]> = [
  ["list orgId", "ORG_REQUIRED", "orgId", (r) => r.rooms.list("")],
  ["get orgId", "ORG_REQUIRED", "orgId", (r) => r.rooms.get("", "prj_1")],
  ["get roomKey", "ROOM_REQUIRED", "roomKey", (r) => r.rooms.get(ORG, "")],
  ["leave presenceId", "ROOM_PRESENCE_ID_REQUIRED", "presenceId", (r) => r.rooms.leave(ORG, "prj_1", "")],
  ["registerPresence orgId", "ORG_REQUIRED", "orgId", (r) => r.rooms.registerPresence("", "prj_1")],
  ["listPresences roomKey", "ROOM_REQUIRED", "roomKey", (r) => r.rooms.listPresences(ORG, "")],
  ["getPresence presenceId", "ROOM_PRESENCE_ID_REQUIRED", "presenceId", (r) => r.rooms.getPresence(ORG, "prj_1", "")],
  ["sendMessage orgId", "ORG_REQUIRED", "orgId", (r) => r.rooms.sendMessage("", "prj_1", { body: "hi" })],
  ["sendMessage body", "ROOM_MESSAGE_BODY_REQUIRED", "body", (r) => r.rooms.sendMessage(ORG, "prj_1", { text: "hi" } as never)],
  ["sendMessage no input", "ROOM_MESSAGE_BODY_REQUIRED", "body", (r) => r.rooms.sendMessage(ORG, "prj_1", undefined as never)],
  ["listMessages orgId", "ORG_REQUIRED", "orgId", (r) => r.rooms.listMessages("", "prj_1")],
  ["waitForMessages roomKey", "ROOM_REQUIRED", "roomKey", (r) => r.rooms.waitForMessages(ORG, "")],
  ["getMessage messageId", "ROOM_MESSAGE_ID_REQUIRED", "messageId", (r) => r.rooms.getMessage(ORG, "prj_1", "")],
  ["ackMessage messageId", "ROOM_MESSAGE_ID_REQUIRED", "messageId", (r) => r.rooms.ackMessage(ORG, "prj_1", "")],
  ["createClaim resource", "ROOM_CLAIM_RESOURCE_REQUIRED", "resource", (r) => r.rooms.createClaim(ORG, "prj_1", { mode: "exclusive" } as never)],
  ["createClaim mode", "ROOM_CLAIM_MODE_REQUIRED", "mode", (r) => r.rooms.createClaim(ORG, "prj_1", { resource: "repo:x/**" } as never)],
  ["listClaims orgId", "ORG_REQUIRED", "orgId", (r) => r.rooms.listClaims("", "prj_1")],
  ["releaseClaim claimId", "ROOM_CLAIM_ID_REQUIRED", "claimId", (r) => r.rooms.releaseClaim(ORG, "prj_1", "")],
  ["invite roomKey", "ROOM_REQUIRED", "roomKey", (r) => r.rooms.invite(ORG, "")],
  ["join key", "ROOM_INVITE_KEY_REQUIRED", "key", (r) => r.rooms.join("")],
  ["forProject projectId", "BAD_PROJECT_ID", "projectId", (r) => r.rooms.forProject("")],
  ["forProject malformed projectId", "BAD_PROJECT_ID", "projectId", (r) => r.rooms.forProject("my project")],
  ["scoped orgId", "ORG_REQUIRED", "orgId", (r) => r.rooms.scoped("", "prj_1")],
  ["scoped roomKey", "ROOM_REQUIRED", "roomKey", (r) => r.rooms.scoped(ORG, "")],
];

describe("rooms input checks carry a code and a next action", () => {
  for (const [label, code, field, call] of cases) {
    it(`${label} -> ${code}`, async () => {
      const { r, calls } = makeSdk();
      await assert.rejects(
        (async () => call(r))(),
        (err: unknown) => {
          assert.ok(isLocalError(err), `expected LocalError, got ${String(err)}`);
          assert.equal(err.code, code);
          assert.equal(err.nextActions?.length, 1, "exactly one next action");
          const action = err.nextActions![0] as { type?: string; why?: string };
          assert.equal(action.type, "edit_request");
          assert.match(action.why ?? "", new RegExp(`\\b${field}\\b`), "the next action names the expected field");
          return true;
        },
      );
      assert.equal(calls.length, 0);
    });
  }
});
