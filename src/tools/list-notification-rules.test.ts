import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

let calls: unknown[] = [];
let nextListImpl: () => Promise<unknown> = async () => ({ rules: [] });

mock.module("../allowance-auth.js", {
  namedExports: {
    requireAllowanceAuth: () => ({ headers: { "SIGN-IN-WITH-X": "dGVzdA==" } }),
  },
});

mock.module("../sdk.js", {
  namedExports: {
    getSdk: () => ({
      admin: {
        rules: {
          list: async () => {
            calls.push("list");
            return nextListImpl();
          },
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

const { handleListNotificationRules } = await import("./list-notification-rules.js");

beforeEach(() => {
  calls = [];
  nextListImpl = async () => ({ rules: [] });
});

describe("list_notification_rules", () => {
  it("calls admin.rules.list with no args and returns the envelope verbatim", async () => {
    nextListImpl = async () => ({
      rules: [
        {
          id: "rule_1",
          recipient_email: "ops@example.com",
          project_id: null,
          source: "app",
          event_types: ["signature_failed"],
          classes: null,
          channel: "telegram",
          telegram_binding_id: "bnd_1",
          enabled: true,
          created_at: "2026-07-16T00:00:00Z",
          updated_at: "2026-07-16T00:00:00Z",
        },
      ],
    });

    const result = await handleListNotificationRules({});

    assert.deepEqual(calls, ["list"]);
    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0]!.text);
    assert.equal(parsed.rules.length, 1);
    assert.equal(parsed.rules[0].telegram_binding_id, "bnd_1");
  });
});
