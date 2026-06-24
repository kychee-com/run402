/**
 * cli-bootstrap-next-actions.test.mjs — the cold-start chain
 * (change: keep-agent-in-loop-on-cold-start).
 *
 * An agent that knows only one verb must be walked, failure by failure, to a
 * deployed result via typed `next_actions[]`. These tests pin the bootstrap
 * chokepoint failures (config.mjs) and the tier hop so the chain never breaks
 * silently. Isolated to a fresh empty config dir — no allowance, no keystore —
 * which IS the cold-machine state.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set BEFORE any CLI module import — config.mjs resolves paths from this.
const tempDir = mkdtempSync(join(tmpdir(), "run402-bootstrap-"));
process.env.RUN402_CONFIG_DIR = tempDir;
process.env.RUN402_API_BASE = "https://test-api.run402.com";

const originalError = console.error;
const originalExit = process.exit;
let stderrLines = [];

function captureStart() {
  stderrLines = [];
  console.error = (...args) =>
    stderrLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  process.exit = (code) => {
    throw new Error(`process.exit(${code})`);
  };
}

function captureStop() {
  console.error = originalError;
  process.exit = originalExit;
}

function parseEnvelope() {
  const line = stderrLines.find((s) => s.trim().startsWith("{"));
  assert.ok(line, `expected a JSON error envelope on stderr, got: ${stderrLines.join("\n")}`);
  return JSON.parse(line);
}

// Run a thunk expected to call the throwing process.exit stub, return the envelope.
function expectFailEnvelope(thunk) {
  let threw = null;
  captureStart();
  try {
    thunk();
  } catch (e) {
    threw = e;
  } finally {
    captureStop();
  }
  assert.equal(threw?.message, "process.exit(1)", "must exit non-zero");
  return parseEnvelope();
}

async function expectFailEnvelopeAsync(thunk) {
  let threw = null;
  captureStart();
  try {
    await thunk();
  } catch (e) {
    threw = e;
  } finally {
    captureStop();
  }
  assert.equal(threw?.message, "process.exit(1)", "must exit non-zero");
  return parseEnvelope();
}

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("cold-start bootstrap next_actions (config.mjs chokepoint)", () => {
  it("resolveProjectId with no active project names create_project", async () => {
    const { resolveProjectId } = await import("./cli/lib/config.mjs");
    const env = expectFailEnvelope(() => resolveProjectId(null));
    assert.equal(env.code, "NO_ACTIVE_PROJECT");
    assert.ok(Array.isArray(env.next_actions) && env.next_actions.length > 0, "non-empty next_actions");
    assert.equal(env.next_actions[0].type, "create_project");
    assert.equal(env.next_actions[0].command, "run402 projects provision");
  });

  it("findProject for an unknown id names create_project", async () => {
    const { findProject } = await import("./cli/lib/config.mjs");
    const env = expectFailEnvelope(() => findProject("prj_does_not_exist"));
    assert.equal(env.code, "PROJECT_NOT_FOUND");
    assert.equal(env.next_actions[0].type, "create_project");
    assert.equal(env.next_actions[0].command, "run402 projects provision");
  });

  it("allowanceAuthHeaders with no allowance names initialize_wallet", async () => {
    const { allowanceAuthHeaders } = await import("./cli/lib/config.mjs");
    const env = expectFailEnvelope(() => allowanceAuthHeaders("/projects/v1"));
    assert.equal(env.code, "NO_ALLOWANCE");
    assert.equal(env.next_actions[0].type, "initialize_wallet");
    assert.equal(env.next_actions[0].command, "run402 init");
  });
});

describe("cold-start bootstrap next_actions (chain hops)", () => {
  it("tier set with no tier arg names renew_tier", async () => {
    const { run } = await import("./cli/lib/tier.mjs");
    const env = await expectFailEnvelopeAsync(() => run("set", []));
    assert.equal(env.code, "BAD_USAGE");
    assert.equal(env.next_actions[0].type, "renew_tier");
    assert.match(env.next_actions[0].command, /^run402 tier set /);
  });

  it("provision with no allowance names initialize_wallet", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    const env = await expectFailEnvelopeAsync(() => run("provision", []));
    assert.equal(env.code, "NO_ALLOWANCE");
    assert.equal(env.next_actions[0].type, "initialize_wallet");
    assert.equal(env.next_actions[0].command, "run402 init");
  });
});
