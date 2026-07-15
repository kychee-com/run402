/**
 * list_project_events MCP tool.
 *
 * The tool is a thin shim: it maps snake_case args -> the SDK's camelCase
 * opts (event_type -> eventType, source 1:1), calls
 * `getSdk().events.list` / `.listForOrg`, and returns the SDK page as
 * `JSON.stringify(page, null, 2)` in a single text block — no reshaping.
 * These tests prove the arg->opts mapping (including the new source/
 * event_type filters from kychee-com/run402#497) and that the emitted text
 * is BYTE-EQUAL to JSON.stringify of the exact SDK return value (MCP<->SDK
 * parity). The gateway envelope itself is passed through untouched by the
 * SDK (covered in sdk/src/namespaces/events.test.ts).
 *
 * Run: node --experimental-test-module-mocks --test --import tsx src/tools/list-project-events.test.ts
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

const CANNED_PAGE = {
  events: [
    {
      id: "evc_2c",
      event_type: "signature_completed",
      class: "app",
      occurred_at: "2026-07-11T09:14:03.000Z",
      payload: { request_id: "r1" },
      next_actions: [{ type: "poll", method: "GET", path: "/projects/v1/prj_x/events?cursor=evc_2c" }],
    },
  ],
  cursor: "evc_2c",
  has_more: false,
  reset: false,
};

// Recorded SDK calls + per-test overridable behavior for the stubbed namespace.
let calls: Array<{ method: string; args: unknown[] }> = [];
let listBehavior: (projectId: string, opts: unknown) => Promise<unknown>;
let listForOrgBehavior: (orgId: string, opts: unknown) => Promise<unknown>;

mock.module("../sdk.js", {
  namedExports: {
    getSdk: () => ({
      events: {
        list: (projectId: string, opts: unknown) => {
          calls.push({ method: "list", args: [projectId, opts] });
          return listBehavior(projectId, opts);
        },
        listForOrg: (orgId: string, opts: unknown) => {
          calls.push({ method: "listForOrg", args: [orgId, opts] });
          return listForOrgBehavior(orgId, opts);
        },
      },
    }),
    _resetSdk: () => {},
  },
});

const { handleListProjectEvents } = await import("./list-project-events.js");

beforeEach(() => {
  calls = [];
  listBehavior = async () => CANNED_PAGE;
  listForOrgBehavior = async () => CANNED_PAGE;
});

describe("list_project_events MCP tool", () => {
  it("project_id only: maps to events.list with no filters", async () => {
    const result = await handleListProjectEvents({ project_id: "prj_x" });

    assert.deepEqual(calls, [{ method: "list", args: ["prj_x", {}] }]);
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0]!.text, JSON.stringify(CANNED_PAGE, null, 2));
  });

  it("passes source through 1:1 to events.list", async () => {
    const result = await handleListProjectEvents({ project_id: "prj_x", source: "app" });

    assert.deepEqual(calls, [{ method: "list", args: ["prj_x", { source: "app" }] }]);
    assert.equal(result.isError, undefined);
  });

  it("maps event_type -> eventType on events.list", async () => {
    await handleListProjectEvents({
      project_id: "prj_x",
      event_type: "signature_completed,booking_created",
    });

    assert.deepEqual(calls, [
      { method: "list", args: ["prj_x", { eventType: "signature_completed,booking_created" }] },
    ]);
  });

  it("composes source + event_type with cursor/limit on events.list", async () => {
    await handleListProjectEvents({
      project_id: "prj_x",
      cursor: "evc_1",
      limit: 10,
      source: "platform",
      event_type: "deploy_activated",
    });

    assert.deepEqual(calls, [
      {
        method: "list",
        args: ["prj_x", { cursor: "evc_1", limit: 10, source: "platform", eventType: "deploy_activated" }],
      },
    ]);
  });

  it("org_id routes to events.listForOrg with the same source/event_type mapping", async () => {
    const result = await handleListProjectEvents({
      org_id: "00000000-0000-0000-0000-aaaaaaaaaaaa",
      source: "app",
      event_type: "signature_completed",
    });

    assert.deepEqual(calls, [
      {
        method: "listForOrg",
        args: ["00000000-0000-0000-0000-aaaaaaaaaaaa", { source: "app", eventType: "signature_completed" }],
      },
    ]);
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0]!.text, JSON.stringify(CANNED_PAGE, null, 2));
  });

  it("neither project_id nor org_id: isError with NO SDK call", async () => {
    const result = await handleListProjectEvents({});

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    assert.match(result.content[0]!.text, /project_id.*org_id/);
  });

  it("both project_id and org_id: isError with NO SDK call", async () => {
    const result = await handleListProjectEvents({ project_id: "prj_x", org_id: "org_y" });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    assert.match(result.content[0]!.text, /not both/);
  });

  it("SDK throw -> mapped error result (isError, context in the text)", async () => {
    listBehavior = async () => {
      throw new Error("kaboom");
    };

    const result = await handleListProjectEvents({ project_id: "prj_x" });

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /reading project events feed/);
    assert.match(result.content[0]!.text, /kaboom/);
  });
});
