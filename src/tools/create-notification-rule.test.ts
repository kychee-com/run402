import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

let calls: unknown[] = [];
let nextCreateImpl: (input: unknown) => Promise<unknown> = async (input) => ({
  id: "rule_1",
  recipient_email: "ops@example.com",
  project_id: null,
  source: null,
  event_types: null,
  classes: null,
  channel: "telegram",
  telegram_binding_id: (input as { telegramBindingId: string }).telegramBindingId,
  enabled: true,
  created_at: "2026-07-16T00:00:00Z",
  updated_at: "2026-07-16T00:00:00Z",
  next_actions: [],
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
        rules: {
          create: async (input: unknown) => {
            calls.push(input);
            return nextCreateImpl(input);
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

const { handleCreateNotificationRule } = await import("./create-notification-rule.js");

beforeEach(() => {
  calls = [];
});

describe("create_notification_rule", () => {
  it("maps only telegram_binding_id when no filters are given (undefined dimensions omitted downstream by the SDK)", async () => {
    const result = await handleCreateNotificationRule({ telegram_binding_id: "bnd_1" });

    assert.deepEqual(calls, [
      { telegramBindingId: "bnd_1", projectId: undefined, source: undefined, eventTypes: undefined, classes: undefined },
    ]);
    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0]!.text);
    assert.equal(parsed.telegram_binding_id, "bnd_1");
  });

  it("maps every snake_case arg to its camelCase SDK input field", async () => {
    await handleCreateNotificationRule({
      telegram_binding_id: "bnd_1",
      project_id: "prj_abc",
      source: "app",
      event_types: ["signature_failed"],
      classes: ["security"],
    });

    assert.deepEqual(calls, [
      {
        telegramBindingId: "bnd_1",
        projectId: "prj_abc",
        source: "app",
        eventTypes: ["signature_failed"],
        classes: ["security"],
      },
    ]);
  });

  it("maps SDK errors via mapSdkError", async () => {
    nextCreateImpl = async () => {
      throw new Error("boom");
    };
    const result = await handleCreateNotificationRule({ telegram_binding_id: "bnd_bad" });
    assert.equal(result.isError, true);
    assert.equal(result.content[0]!.text, "mapped SDK error");
  });
});
