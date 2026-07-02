import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

let calls: unknown[] = [];

mock.module("../sdk.js", {
  namedExports: {
    getSdk: () => ({
      up: async (input: unknown, opts: unknown) => {
        calls.push({ input, opts });
        return {
          action: "up",
          mode: "legacyDryRun",
          dry_run: true,
          target: "cloud",
          steps: [],
          result: {
            project_id: "prj_planned",
            manifest_path: "/tmp/app/run402.json",
            app_result: {
              kind: "run402.up.result",
              status: "planned",
              source: { kind: "local", path: "/tmp/app" },
              next_actions: [],
            },
          },
        };
      },
    }),
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

const { handleAppUp } = await import("./app-up.js");

beforeEach(() => {
  calls = [];
});

describe("app_up tool", () => {
  it("delegates to SDK up and returns the shared app result envelope", async () => {
    const result = await handleAppUp({
      source: ".",
      name: "kysigned2",
      dry_run: true,
      yes: true,
      allow_prune: true,
      max_spend_usd: 0.1,
      build_mode: "local",
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [{
      input: {
        source: ".",
        name: "kysigned2",
        projectId: undefined,
        manifest: undefined,
        dir: undefined,
        tier: undefined,
        idempotencyKey: undefined,
        allowPrune: true,
        maxSpendUsd: 0.1,
        buildMode: "local",
        allowShellBuild: undefined,
      },
      opts: {
        dryRun: true,
        approval: "yes",
      },
    }]);
    const parsed = JSON.parse(result.content[0]!.text);
    assert.equal(parsed.kind, "run402.up.result");
    assert.equal(parsed.status, "planned");
  });
});
