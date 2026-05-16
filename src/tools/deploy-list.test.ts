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
      before: "op_cursor",
      status: "ready",
      since: "2026-05-16T00:00:00Z",
      filter_project_id: "prj_filter",
      include_total: true,
    });

    assert.equal(parsed.before, "op_cursor");
    assert.equal(parsed.status, "ready");
    assert.equal(parsed.filter_project_id, "prj_filter");
    assert.equal(parsed.include_total, true);
  });

  it("forwards list filters to SDK deploy.list and renders new pagination fields", async () => {
    nextListImpl = async () => ({
      operations: [
        {
          operation_id: "op_1",
          status: "ready",
          release_id: "rel_1",
          updated_at: "2026-05-15T00:00:00Z",
        },
      ],
      has_more: true,
      next_cursor: "op_next",
      total: 42,
    });

    const result = await handleDeployList({
      project_id: "prj_test",
      limit: 5,
      before: "op_cursor",
      status: "ready",
      since: "2026-05-16T00:00:00Z",
      filter_project_id: "prj_filter",
      include_total: true,
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [
      {
        project: "prj_test",
        limit: 5,
        before: "op_cursor",
        status: "ready",
        since: "2026-05-16T00:00:00Z",
        project_id: "prj_filter",
        includeTotal: true,
      },
    ]);
    assert.match(result.content[0]!.text, /Next cursor: `op_next`/);
    assert.match(result.content[0]!.text, /Has more: yes/);
    assert.match(result.content[0]!.text, /Total: 42/);
  });
});
