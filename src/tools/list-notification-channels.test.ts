import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

let calls: unknown[] = [];
let nextListImpl: () => Promise<unknown> = async () => ({
  email: { address: null, verified: false },
  webhook: { configured: false, url: null, secret_configured: false },
  telegram: [],
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
        channels: {
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

const { handleListNotificationChannels } = await import("./list-notification-channels.js");

beforeEach(() => {
  calls = [];
  nextListImpl = async () => ({
    email: { address: null, verified: false },
    webhook: { configured: false, url: null, secret_configured: false },
    telegram: [],
  });
});

describe("list_notification_channels", () => {
  it("calls admin.channels.list with no args and returns the envelope verbatim", async () => {
    nextListImpl = async () => ({
      email: { address: "ops@example.com", verified: true },
      webhook: { configured: false, url: null, secret_configured: false },
      telegram: [
        { id: "bnd_1", recipient_email: "ops@example.com", status: "active", chat_id: 1, chat_type: "private", chat_title: null, label: "alerts", consecutive_failures: 0, disabled_at: null, code_expires_at: null, created_at: "2026-07-16T00:00:00Z", activated_at: "2026-07-16T00:05:00Z" },
      ],
    });

    const result = await handleListNotificationChannels({});

    assert.deepEqual(calls, ["list"]);
    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0]!.text);
    assert.equal(parsed.email.verified, true);
    assert.equal(parsed.telegram.length, 1);
    assert.equal(parsed.telegram[0].status, "active");
  });
});
