import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

let calls: unknown[] = [];
let nextDeleteImpl: (ruleId: string) => Promise<unknown> = async (ruleId) => ({
  deleted: true,
  rule_id: ruleId,
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
          delete: async (ruleId: string) => {
            calls.push(ruleId);
            return nextDeleteImpl(ruleId);
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

const { handleDeleteNotificationRule } = await import("./delete-notification-rule.js");

beforeEach(() => {
  calls = [];
  nextDeleteImpl = async (ruleId) => ({ deleted: true, rule_id: ruleId });
});

describe("delete_notification_rule", () => {
  it("forwards rule_id to admin.rules.delete and returns the envelope verbatim", async () => {
    const result = await handleDeleteNotificationRule({ rule_id: "rule_1" });

    assert.deepEqual(calls, ["rule_1"]);
    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0]!.text);
    assert.equal(parsed.deleted, true);
    assert.equal(parsed.rule_id, "rule_1");
  });

  it("maps SDK errors via mapSdkError", async () => {
    nextDeleteImpl = async () => {
      throw new Error("not found");
    };
    const result = await handleDeleteNotificationRule({ rule_id: "rule_missing" });
    assert.equal(result.isError, true);
  });
});
