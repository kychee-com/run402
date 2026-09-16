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

test("interactive target selection requires an explicit answer and yes never selects", async () => {
  const { upWithExplicitSelection } = await import("./up.mjs");
  const missing = Object.assign(new Error("choose"), { code: "UP_PROJECT_REQUIRED" });
  const calls = [];
  const sdk = { up: async (request) => { calls.push(request); if (!request.projectId && !request.name) throw missing; return request; } };
  let questions = 0;
  const terminal = { interactive: true, question: async () => { questions++; return "prj_chosen"; } };
  await assert.rejects(upWithExplicitSelection(sdk, {}, { approval: "yes" }, terminal), { code: "UP_PROJECT_REQUIRED" });
  assert.equal(questions, 0);
  const chosen = await upWithExplicitSelection(sdk, { dir: "app" }, {}, terminal);
  assert.deepEqual(chosen, { dir: "app", projectId: "prj_chosen" });
  assert.equal(questions, 1);
  const created = await upWithExplicitSelection(sdk, {}, {}, { interactive: true, question: async () => "new canal" });
  assert.deepEqual(created, { name: "canal" });
});
