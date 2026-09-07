/**
 * Live-proof defect B — `reportSdkError`'s explicit "you were not charged"
 * hint for the gateway's own terminal room-invite claim refusals.
 *
 * `sdk/src/node/paid-fetch.ts`'s default paid fetch now classifies these
 * five codes as `"failed"` rather than `"ambiguous"`, so by the time an
 * error reaches the CLI it already carries the gateway's own envelope
 * (`code`, `mutation_state: "none"`, etc.) rather than a synthesized
 * `PaymentAttemptError`. This test covers the CLI's own rendering layer:
 * the reassuring fact belongs in the envelope explicitly, not left for the
 * caller to infer from `mutation_state`.
 *
 * `cli/lib/sdk-errors.mjs` has no imports of its own — this test exercises
 * it standalone, mirroring `cli/lib/errors.test.mjs`'s own convention.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { reportSdkError } from "./cli/lib/sdk-errors.mjs";

function captureExit(fn) {
  const originalError = console.error;
  const originalExit = process.exit;
  let stderr = "";
  let exitCode;
  console.error = (line) => { stderr += `${line}\n`; };
  process.exit = (code) => { exitCode = code; throw new Error("__exit__"); };
  try {
    try {
      fn();
    } catch (e) {
      if (e.message !== "__exit__") throw e;
    }
  } finally {
    console.error = originalError;
    process.exit = originalExit;
  }
  return { stderr, exitCode };
}

function fakeApiError(code, extra = {}) {
  return {
    name: "ApiError",
    status: 409,
    message: `${code} while claiming a room invite`,
    body: { code, category: "conflict", mutation_state: "none", ...extra },
  };
}

for (const code of [
  "ROOM_INVITE_KEY_INVALID",
  "ROOM_INVITE_KEY_EXPIRED",
  "ROOM_INVITE_KEY_REVOKED",
  "ROOM_INVITE_KEY_ALREADY_CLAIMED",
  "ROOM_INVITE_CLAIM_REQUIRES_WALLET",
]) {
  test(`reportSdkError adds a "not charged" hint for ${code}`, () => {
    const { stderr, exitCode } = captureExit(() => reportSdkError(fakeApiError(code)));
    assert.equal(exitCode, 1);
    const payload = JSON.parse(stderr.trim());
    assert.equal(payload.code, code);
    assert.match(payload.hint, /not charged/i);
    assert.equal(payload.mutation_state, "none");
  });
}

test("reportSdkError never adds the room-invite hint for an unrelated code", () => {
  const { stderr } = captureExit(() => reportSdkError(fakeApiError("ROOM_INVITE_OPEN_LIMIT")));
  const payload = JSON.parse(stderr.trim());
  assert.equal(payload.code, "ROOM_INVITE_OPEN_LIMIT");
  assert.equal(payload.hint, undefined);
});

test("reportSdkError never overrides a hint the gateway/SDK already supplied", () => {
  const { stderr } = captureExit(() =>
    reportSdkError(fakeApiError("ROOM_INVITE_KEY_ALREADY_CLAIMED", { hint: "a more specific upstream hint" })));
  const payload = JSON.parse(stderr.trim());
  assert.equal(payload.hint, "a more specific upstream hint");
});
