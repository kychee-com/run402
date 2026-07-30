import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

let sdk;
const authModes = [];

mock.module("./sdk.mjs", {
  namedExports: {
    getSdk: (options = {}) => {
      authModes.push(options.authMode ?? "default");
      return sdk;
    },
  },
});

const { run } = await import("./buzz.mjs");

let stdout;
let stderr;

beforeEach(() => {
  stdout = [];
  stderr = [];
  authModes.length = 0;
  mock.method(console, "log", (value) => stdout.push(String(value)));
  mock.method(console, "error", (value) => stderr.push(String(value)));
});

afterEach(() => mock.restoreAll());

describe("run402 buzz CLI", () => {
  it("renders the four independent lifecycle states in help", async () => {
    sdk = {};
    await run("help");
    assert.match(stdout.join("\n"), /skill installation/);
    assert.match(stdout.join("\n"), /community installation/);
    assert.match(stdout.join("\n"), /human adoption/);
    assert.match(stdout.join("\n"), /agent enrollment/);
  });

  it("reports an older gateway as unsupported without attempting a mutation", async () => {
    sdk = {
      buzz: {
        status: async () => ({
          supported: false,
          protocol: "run402.buzz-control-plane.v1",
          reason: "gateway_not_supported",
          buzz: null,
        }),
      },
    };
    await run("status");
    assert.equal(JSON.parse(stdout[0]).supported, false);
    assert.match(stderr.join("\n"), /predates/);
  });

  it("maps a Honey enrollment file to the goal-shaped SDK call and prints only JSON", async () => {
    const directory = mkdtempSync(join(tmpdir(), "run402-buzz-cli-"));
    const grantsPath = join(directory, "grants.json");
    const grants = [{
      project_id: "prj_existing",
      capability: "deploy",
      policy: {},
      expires_at: "2026-08-01T00:00:00.000Z",
    }];
    writeFileSync(grantsPath, JSON.stringify(grants));
    let observed;
    sdk = {
      buzz: {
        enroll: async (input) => {
          observed = input;
          return { buzz_agent_enrollment_id: `buzzae_${"1".repeat(32)}`, status: "pending" };
        },
      },
    };
    try {
      await run("enroll", [
        "--installation", `buzzci_${"2".repeat(32)}`,
        "--identity-link", `idlnk_${"3".repeat(32)}`,
        "--grants-file", grantsPath,
        "--expires-at", "2026-08-01T00:00:00.000Z",
        "--idempotency-key", "honey-request-1",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    assert.deepEqual(observed.requestedGrants, grants);
    assert.equal(observed.idempotencyKey, "honey-request-1");
    assert.deepEqual(authModes, ["wallet"]);
    assert.equal(JSON.parse(stdout[0]).status, "pending");
    assert.match(stderr.join("\n"), /pending/);
  });

  it("discovers descriptors by community without authentication", async () => {
    let observed;
    sdk = {
      buzz: {
        communityInstallations: {
          discoverPublicDescriptors: async (community) => {
            observed = community;
            return [{ provider: "run402", status: "active" }];
          },
        },
      },
    };
    await run("install", ["discover", "--community", "buzz:community:acme.communities.buzz.xyz"]);
    assert.equal(observed, "buzz:community:acme.communities.buzz.xyz");
    assert.deepEqual(authModes, ["none"]);
    assert.equal(JSON.parse(stdout[0])[0].provider, "run402");
  });

  it("updates and revokes a Run402 installation without asking Buzz to sign again", async () => {
    const directory = mkdtempSync(join(tmpdir(), "run402-buzz-cli-policy-"));
    const policyPath = join(directory, "policy.json");
    writeFileSync(policyPath, JSON.stringify({ mode: "manual", requires_current_community_membership: true }));
    const calls = [];
    sdk = {
      buzz: {
        communityInstallations: {
          update: async (id, input) => { calls.push(["update", id, input]); return { status: "active" }; },
          revoke: async (id, key) => { calls.push(["revoke", id, key]); return { status: "revoked" }; },
        },
      },
    };
    try {
      await run("install", ["update", `buzzci_${"2".repeat(32)}`, "--policy-file", policyPath, "--policy-revision", "1", "--default", "true", "--idempotency-key", "select-default-1"]);
      await run("install", ["revoke", `buzzci_${"2".repeat(32)}`, "--idempotency-key", "revoke-installation-1"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    assert.equal(calls[0][2].authorityProof, undefined);
    assert.equal(calls[1][2], "revoke-installation-1");
  });
});
