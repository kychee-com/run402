import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;

let stdout = [];
let stderr = [];
let upCalls = [];
let upImpl = async () => ({ ok: true });

mock.module("./cli/lib/sdk.mjs", {
  namedExports: {
    getSdk: () => ({
      up: (input, options) => {
        upCalls.push({ input, options });
        return upImpl(input, options);
      },
    }),
  },
});

function captureStart() {
  stdout = [];
  stderr = [];
  console.log = (...args) => stdout.push(args.map(String).join(" "));
  console.error = (...args) => stderr.push(args.map(String).join(" "));
}

function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

function stderrJson() {
  const jsonLines = stderr.filter((s) => s.trim().startsWith("{"));
  const line = jsonLines.find((s) => {
    try {
      return JSON.parse(s).status === "error";
    } catch {
      return false;
    }
  }) ?? jsonLines[0];
  assert.ok(line, `expected JSON stderr, got: ${stderr.join("\n")}`);
  return JSON.parse(line);
}

async function expectExit1(fn) {
  let threw = null;
  captureStart();
  try {
    await fn();
  } catch (err) {
    threw = err;
  } finally {
    captureStop();
  }
  assert.equal(threw?.message, "process.exit(1)");
  return stderrJson();
}

before(() => {
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
});

after(() => {
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
});

beforeEach(() => {
  upCalls = [];
  upImpl = async () => ({ ok: true });
  captureStop();
});

describe("up argv and JSON output", () => {
  it("passes app-up source, spend, prune, and build controls to the SDK", async () => {
    upImpl = async () => ({
      kind: "run402.action.result",
      result: {
        app_result: {
          kind: "run402.up.result",
          schema_version: "run402.up.result.v1",
          status: "blocked",
          next_actions: [{ type: "set_secret", env: "KYSIGNED_ALLOWED_CREATORS" }],
        },
      },
    });
    const { run } = await import("./cli/lib/up.mjs");

    captureStart();
    try {
      await run([
        "https://github.com/kychee-com/kysigned",
        "--name", "kysigned2",
        "--yes",
        "--allow-prune",
        "--max-spend-usd", "0.10",
        "--build-mode", "remote",
        "--allow-shell-build",
        "--json",
      ]);
    } finally {
      captureStop();
    }

    assert.equal(upCalls.length, 1);
    assert.equal(upCalls[0].input.source, "https://github.com/kychee-com/kysigned");
    assert.equal(upCalls[0].input.name, "kysigned2");
    assert.equal(upCalls[0].input.allowPrune, true);
    assert.equal(upCalls[0].input.maxSpendUsd, 0.10);
    assert.equal(upCalls[0].input.buildMode, "remote");
    assert.equal(upCalls[0].input.allowShellBuild, true);
    assert.equal(upCalls[0].options.approval, "yes");
    assert.equal(stdout.length, 1);
    const parsed = JSON.parse(stdout[0]);
    assert.equal(parsed.result.app_result.kind, "run402.up.result");
    assert.equal(stderr.length, 0, "--json should not emit progress JSON on stderr when the SDK emits no events");
  });

  it("emits NDJSON events and a final result for --json-stream", async () => {
    upImpl = async (_input, options) => {
      options.onEvent?.({ phase: "discover", message: "loaded run402.json" });
      return {
        kind: "run402.action.result",
        result: {
          app_result: {
            kind: "run402.up.result",
            status: "planned",
          },
        },
      };
    };
    const { run } = await import("./cli/lib/up.mjs");

    captureStart();
    try {
      await run([".", "--name", "kysigned2", "--json-stream"]);
    } finally {
      captureStop();
    }

    assert.deepEqual(stdout.map((line) => JSON.parse(line).type), [
      "action.event",
      "run402.up.result",
    ]);
    assert.deepEqual(stderr, [], "--json-stream progress belongs on stdout NDJSON only");
  });

  it("prints app-up result JSON by default", async () => {
    upImpl = async () => ({
      kind: "run402.action.result",
      result: {
        app_result: {
          kind: "run402.up.result",
          status: "succeeded",
          project: {
            public_origin: "https://kysigned3.run402.com",
          },
          diagnostics: [],
          next_actions: [],
        },
      },
    });
    const { run } = await import("./cli/lib/up.mjs");

    captureStart();
    try {
      await run(["https://github.com/kychee-com/kysigned", "--name", "kysigned3", "--yes"]);
    } finally {
      captureStop();
    }

    const parsed = JSON.parse(stdout.join("\n"));
    assert.equal(parsed.result.app_result.status, "succeeded");
    assert.equal(parsed.result.app_result.project.public_origin, "https://kysigned3.run402.com");
  });

  it("prints a happy app-up success summary with --human", async () => {
    upImpl = async () => ({
      kind: "run402.action.result",
      result: {
        app_result: {
          kind: "run402.up.result",
          status: "succeeded",
          project: {
            public_origin: "https://kysigned3.run402.com",
          },
          diagnostics: [],
          next_actions: [],
        },
      },
    });
    const { run } = await import("./cli/lib/up.mjs");

    captureStart();
    try {
      await run(["https://github.com/kychee-com/kysigned", "--name", "kysigned3", "--yes", "--human"]);
    } finally {
      captureStop();
    }

    assert.equal(stdout.join("\n"), "Success! Project is up at: https://kysigned3.run402.com");
  });

  it("prints a happy deploy-manifest success summary with --human", async () => {
    upImpl = async () => ({
      action: "up",
      mode: "apply",
      dry_run: false,
      result: {
        project_id: "prj_123",
        deploy: {
          release_id: "rel_123",
          urls: {
            site: "https://kysigned3.run402.com",
            deployment: "https://dpl-test.sites.run402.com",
          },
        },
      },
    });
    const { run } = await import("./cli/lib/up.mjs");

    captureStart();
    try {
      await run(["--project", "prj_123", "--yes", "--human"]);
    } finally {
      captureStop();
    }

    assert.equal(stdout.join("\n"), "Success! Project is up at: https://kysigned3.run402.com\nRelease: rel_123");
  });

  it("prints app-up missing secret details as JSON by default", async () => {
    upImpl = async () => ({
      kind: "run402.action.result",
      result: {
        app_result: {
          kind: "run402.up.result",
          status: "blocked",
          project: {
            public_origin: "https://kysigned3.run402.com",
          },
          diagnostics: [{
            code: "MISSING_SECRET",
            message: "Required user secret KYSIGNED_ALLOWED_CREATORS is missing. Usage: Allowed request creators. Comma-separated emails or domain wildcards such as *@example.com.",
          }],
          next_actions: [{
            type: "set_user_secret",
            message: "Provide KYSIGNED_ALLOWED_CREATORS in the environment before retrying. Usage: Allowed request creators. Comma-separated emails or domain wildcards such as *@example.com.",
            command: 'KYSIGNED_ALLOWED_CREATORS="<value>" run402 up --name <name> --yes',
          }],
        },
      },
    });
    const { run } = await import("./cli/lib/up.mjs");

    captureStart();
    try {
      await run(["https://github.com/kychee-com/kysigned", "--name", "kysigned3", "--yes"]);
    } finally {
      captureStop();
    }

    const parsed = JSON.parse(stdout.join("\n"));
    assert.equal(parsed.result.app_result.status, "blocked");
    assert.match(parsed.result.app_result.diagnostics[0].message, /\*@example\.com/);
    assert.match(parsed.result.app_result.next_actions[0].command, /KYSIGNED_ALLOWED_CREATORS="<value>"/);
  });

  it("rejects a positional source plus --dir before invoking the SDK", async () => {
    const { run } = await import("./cli/lib/up.mjs");
    const err = await expectExit1(() => run([".", "--dir", "."]));

    assert.equal(err.code, "BAD_USAGE");
    assert.match(err.message, /either a positional repo\/path source or --dir/);
    assert.equal(upCalls.length, 0);
  });

  it("rejects conflicting up output modes before invoking the SDK", async () => {
    const { run } = await import("./cli/lib/up.mjs");
    const err = await expectExit1(() => run([".", "--human", "--json-stream"]));

    assert.equal(err.code, "BAD_USAGE");
    assert.match(err.message, /--human cannot be combined/);
    assert.equal(upCalls.length, 0);
  });

  it("rejects invalid app build and spend flags before invoking the SDK", async () => {
    const { run } = await import("./cli/lib/up.mjs");
    const buildMode = await expectExit1(() => run(["--build-mode", "local-ish"]));
    assert.equal(buildMode.code, "BAD_FLAG");
    assert.equal(buildMode.details.flag, "--build-mode");

    const spend = await expectExit1(() => run(["--max-spend-usd", "-1"]));
    assert.equal(spend.code, "BAD_FLAG");
    assert.equal(spend.details.flag, "--max-spend-usd");
    assert.equal(upCalls.length, 0);
  });
});
