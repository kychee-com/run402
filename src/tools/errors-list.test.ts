/**
 * errors_list MCP tool — the MCP↔SDK parity leg of kychee-com/run402#493.
 *
 * The tool is a thin shim: it maps snake_case args → the SDK's camelCase opts,
 * calls `getSdk().errors.list` / `.get`, and returns the SDK page/detail as
 * `JSON.stringify(page, null, 2)` in a single text block — no reshaping. These
 * tests prove that at runtime: (a) the arg→opts mapping (new_in → newIn), and
 * (b) that the emitted text is BYTE-EQUAL to JSON.stringify of the exact SDK
 * return value (MCP↔SDK parity). The gateway envelope itself is passed through
 * untouched by the SDK (covered in sdk/src/namespaces/errors.test.ts), so
 * CLI-JSON, SDK, and MCP all surface one contract.
 *
 * Run: node --experimental-test-module-mocks --test --import tsx src/tools/errors-list.test.ts
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// A canned SDK page/detail. The stubbed SDK returns these BY REFERENCE, so the
// parity assertion compares the tool's emitted text to JSON.stringify of the
// very same object the SDK handed back.
const CANNED_PAGE = {
  verdict: {
    window: { since: "2026-07-11T00:00:00.000Z", until: "2026-07-12T00:00:00.000Z" },
    compared_release_id: "rel_x",
    baseline_release_id: "rel_old",
    new_fingerprints: 1,
    recurring_fingerprints: 2,
    invocations_in_window: 4210,
    coverage: { full_fidelity_functions: 3, coarse_functions: 1 },
    row_cap: { limit: 5000, at_cap: false },
  },
  errors: [
    {
      fingerprint_id: "fp_deadbeef01234567",
      function: "checkout",
      kind: "uncaught",
      fingerprint_quality: "frame_names",
      error_name: "TypeError",
      message_template: 'Cannot read properties of undefined (reading "id")',
      stable_frames: ["user_default", "chargeCard"],
      count: 12,
      first_seen: "2026-07-11T09:00:00.000Z",
      last_seen: "2026-07-11T09:30:00.000Z",
      first_seen_release_id: "rel_x",
      last_seen_release_id: "rel_x",
      samples: {
        first: { id: "req_aaa", at: "2026-07-11T09:00:00.000Z", release_id: "rel_x" },
        recent: [{ id: "req_bbb", at: "2026-07-11T09:30:00.000Z", release_id: "rel_x" }],
      },
      next_actions: [
        { type: "fetch_logs", command: "run402 logs checkout --request-id req_bbb", why: "Retrieve the logs." },
      ],
    },
  ],
  has_more: false,
};

const CANNED_DETAIL = {
  ...CANNED_PAGE.errors[0],
  also_seen_in_functions: ["reports", "webhook"],
};

// Recorded SDK calls + per-test overridable behavior for the stubbed namespace.
let calls: Array<{ method: string; args: unknown[] }> = [];
let listBehavior: (projectId: string, opts: unknown) => Promise<unknown>;
let getBehavior: (projectId: string, fingerprintId: string) => Promise<unknown>;

mock.module("../sdk.js", {
  namedExports: {
    getSdk: () => ({
      errors: {
        list: (projectId: string, opts: unknown) => {
          calls.push({ method: "list", args: [projectId, opts] });
          return listBehavior(projectId, opts);
        },
        get: (projectId: string, fingerprintId: string) => {
          calls.push({ method: "get", args: [projectId, fingerprintId] });
          return getBehavior(projectId, fingerprintId);
        },
      },
    }),
    _resetSdk: () => {},
  },
});

const { handleErrorsList } = await import("./errors-list.js");

beforeEach(() => {
  calls = [];
  listBehavior = async () => CANNED_PAGE;
  getBehavior = async () => CANNED_DETAIL;
});

describe("errors_list MCP tool", () => {
  it("list: maps snake_case args → SDK opts and emits the SDK page BYTE-EQUAL (MCP↔SDK parity)", async () => {
    const result = await handleErrorsList({
      project_id: "prj_x",
      new_in: "rel_x",
      kind: "uncaught",
      limit: 5,
    });

    // (a) snake→camel mapping: new_in → newIn, others 1:1; absent filters omitted.
    assert.deepEqual(calls, [
      { method: "list", args: ["prj_x", { newIn: "rel_x", kind: "uncaught", limit: 5 }] },
    ]);
    // (b) MCP↔SDK parity: the tool emits JSON.stringify(page, null, 2) of the SDK
    // return value verbatim — byte-for-byte, no reshaping.
    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]!.type, "text");
    assert.equal(result.content[0]!.text, JSON.stringify(CANNED_PAGE, null, 2));
  });

  it("detail: fingerprint_id routes to errors.get and returns its result verbatim", async () => {
    const result = await handleErrorsList({
      project_id: "prj_x",
      fingerprint_id: "fp_paritytest01",
    });

    assert.deepEqual(calls, [
      { method: "get", args: ["prj_x", "fp_paritytest01"] },
    ]);
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0]!.text, JSON.stringify(CANNED_DETAIL, null, 2));
  });

  it("mutual exclusion: fingerprint_id + a list filter is isError with NO SDK call", async () => {
    const result = await handleErrorsList({
      project_id: "prj_x",
      fingerprint_id: "fp_paritytest01",
      kind: "uncaught",
    });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0, "must not touch the SDK when args are mutually exclusive");
    assert.match(result.content[0]!.text, /single detail row|drop the list filters/);
  });

  it("SDK throw → mapped error result (isError, context in the text)", async () => {
    listBehavior = async () => {
      throw new Error("kaboom");
    };

    const result = await handleErrorsList({ project_id: "prj_x" });

    assert.equal(result.isError, true);
    // mapSdkError formats the thrown error with the tool's context phrase.
    assert.match(result.content[0]!.text, /reading release error fingerprints/);
    assert.match(result.content[0]!.text, /kaboom/);
  });
});
