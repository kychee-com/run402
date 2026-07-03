import assert from "node:assert/strict";
import test from "node:test";
import { shouldExitNonZeroForUpResult } from "./up.mjs";

test("run402 up exits nonzero for deployed-but-unverified app results", () => {
  assert.equal(shouldExitNonZeroForUpResult({
    action: "up",
    mode: "apply",
    result: {
      app_result: { status: "deployed_unverified" },
    },
  }), true);

  assert.equal(shouldExitNonZeroForUpResult({
    action: "up",
    mode: "apply",
    result: {
      app_result: { status: "succeeded" },
    },
  }), false);

  assert.equal(shouldExitNonZeroForUpResult({
    action: "up",
    mode: "check",
    result: {
      app_result: { status: "deployed_unverified" },
    },
  }), false);
});
