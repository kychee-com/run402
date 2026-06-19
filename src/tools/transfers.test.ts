import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

let calls: Array<{ method: string; input: unknown }> = [];

mock.module("../sdk.js", {
  namedExports: {
    getSdk: () => ({
      admin: {
        transfers: {
          initiate: async (input: unknown) => {
            calls.push({ method: "initiate", input });
            return {
              status: "accepted",
              transfer_id: "ptx_org",
              project_id: "prj_123",
              to_organization_id: "org_123",
              completed_at: "2026-06-19T12:00:00Z",
              anon_key: "anon_new",
              service_key: "svc_new",
            };
          },
        },
      },
    }),
    _resetSdk: () => {},
  },
});

const { handleInitiateProjectTransfer } = await import("./transfers.js");

beforeEach(() => {
  calls = [];
});

describe("project transfer MCP tools", () => {
  it("initiates owned-org transfers through the SDK toOrgId shape", async () => {
    const result = await handleInitiateProjectTransfer({
      project_id: "prj_123",
      to_org_id: "org_123",
      message: "move",
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [
      {
        method: "initiate",
        input: {
          projectId: "prj_123",
          toOrgId: "org_123",
          message: "move",
        },
      },
    ]);
    assert.match(result.content[0]!.text, /moved to org `org_123`/);
    assert.match(result.content[0]!.text, /persisted to the local keystore/);
  });

  it("requires exactly one recipient before SDK calls", async () => {
    const result = await handleInitiateProjectTransfer({
      project_id: "prj_123",
      to_wallet: "0xbeef",
      to_org_id: "org_123",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /exactly one/);
    assert.deepEqual(calls, []);
  });

  it("rejects wallet/email-only fields on owned-org transfers before SDK calls", async () => {
    const result = await handleInitiateProjectTransfer({
      project_id: "prj_123",
      to_org_id: "org_123",
      kysigned_record_id: "ks_1",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /kysigned_record_id/);
    assert.deepEqual(calls, []);
  });
});
