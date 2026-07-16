import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

let calls: unknown[] = [];
let nextTestImpl: (opts: unknown) => Promise<unknown> = async () => ({
  status: "queued",
  source_event_id: "0xabc:123",
  drained: { claimed: 0, delivered: 0, skipped: 0, failed_transient: 0, failed_permanent: 0 },
  telegram: { destinations: [] },
  note: "queued",
});

mock.module("../allowance-auth.js", {
  namedExports: {
    requireAllowanceAuth: () => ({ headers: { "SIGN-IN-WITH-X": "dGVzdA==" } }),
  },
});

mock.module("../sdk.js", {
  namedExports: {
    getSdk: () => ({
      admin: {
        testNotification: async (opts: unknown) => {
          calls.push(opts);
          return nextTestImpl(opts);
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

const { handleTestNotification } = await import("./test-notification.js");

beforeEach(() => {
  calls = [];
  nextTestImpl = async () => ({
    status: "queued",
    source_event_id: "0xabc:123",
    drained: { claimed: 0, delivered: 0, skipped: 0, failed_transient: 0, failed_permanent: 0 },
    telegram: { destinations: [] },
    note: "queued",
  });
});

describe("test_notification", () => {
  it("forwards undefined source/event_type when omitted", async () => {
    await handleTestNotification({});
    assert.deepEqual(calls, [{ source: undefined, eventType: undefined }]);
  });

  it("maps source/event_type (snake_case args) to source/eventType (SDK opts)", async () => {
    nextTestImpl = async () => ({
      status: "delivered",
      source_event_id: "0xabc:123",
      drained: { claimed: 1, delivered: 1, skipped: 0, failed_transient: 0, failed_permanent: 0 },
      telegram: {
        destinations: [{ binding_id: "bnd_1", label: "alerts", delivered: true }],
      },
      note: "delivered",
    });

    const result = await handleTestNotification({ source: "app", event_type: "signature_failed" });

    assert.deepEqual(calls, [{ source: "app", eventType: "signature_failed" }]);
    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0]!.text);
    assert.equal(parsed.telegram.destinations.length, 1);
    assert.equal(parsed.telegram.destinations[0].delivered, true);
  });
});
