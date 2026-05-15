import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

let calls: unknown[] = [];
let nextListImpl: (opts: unknown) => Promise<unknown> = async () => ({
  operations: [],
  cursor: null,
});

mock.module("../allowance-auth.js", {
  namedExports: {
    requireAllowanceAuth: () => ({ headers: { "SIGN-IN-WITH-X": "dGVzdA==" } }),
  },
});

mock.module("../sdk.js", {
  namedExports: {
    getSdk: () => ({
      deploy: {
        list: async (opts: unknown) => {
          calls.push(opts);
          return nextListImpl(opts);
        },
      },
    }),
    _resetSdk: () => {},
  },
});

mock.module("../errors.js", {
  namedExports: {
    mapSdkError: () => ({
      content: [{ type: "text", text: "mapped SDK error" }],
      isError: true,
    }),
  },
});

const { deployListSchema, handleDeployList } = await import("./deploy-list.js");

beforeEach(() => {
  calls = [];
  nextListImpl = async () => ({
    operations: [],
    cursor: null,
  });
});

describe("deploy_list", () => {
  it("accepts a pagination cursor in the schema", () => {
    const parsed = z.object(deployListSchema).parse({
      project_id: "prj_test",
      limit: 5,
      cursor: "op_cursor",
    });

    assert.equal(parsed.cursor, "op_cursor");
  });

  it("forwards cursor to SDK deploy.list and still renders the next cursor", async () => {
    nextListImpl = async () => ({
      operations: [
        {
          operation_id: "op_1",
          status: "ready",
          release_id: "rel_1",
          updated_at: "2026-05-15T00:00:00Z",
        },
      ],
      cursor: "op_next",
    });

    const result = await handleDeployList({
      project_id: "prj_test",
      limit: 5,
      cursor: "op_cursor",
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [
      { project: "prj_test", limit: 5, cursor: "op_cursor" },
    ]);
    assert.match(result.content[0]!.text, /Next cursor: `op_next`/);
  });
});
