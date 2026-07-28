import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { run } from "./cli/lib/identity.mjs";

const originalExit = process.exit;
const originalError = console.error;
const originalLog = console.log;
const originalFetch = globalThis.fetch;
let stderr = [];
let stdout = [];
let fetchCalls = 0;

before(() => {
  process.exit = (code) => { throw new Error(`exit:${code}`); };
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error("network must not be reached"); };
  console.error = (...args) => stderr.push(args.map(String).join(" "));
  console.log = (...args) => stdout.push(args.map(String).join(" "));
});

after(() => {
  process.exit = originalExit;
  console.error = originalError;
  console.log = originalLog;
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  stderr = [];
  stdout = [];
  fetchCalls = 0;
});

describe("identity link CLI secret boundary", () => {
  for (const flag of ["--nostr-key", "--nsec", "--private-key", "--mnemonic", "--seed", "--derivation", "--display-name", "--signed-label"]) {
    it(`rejects ${flag} locally without echoing its value`, async () => {
      const marker = "DO_NOT_ECHO_72ad09";
      await assert.rejects(run("link", ["nostr", "begin", "--pubkey", "f".repeat(64), "--visibility", "public", flag, marker]), /exit:1/);
      assert.equal(fetchCalls, 0);
      assert.equal(stdout.length, 0);
      const envelope = JSON.parse(stderr[0]);
      assert.equal(envelope.code, "UNKNOWN_FLAG");
      assert.equal(envelope.details.flag, flag);
      assert.doesNotMatch(stderr.join("\n"), new RegExp(marker));
    });
  }

  it("requires an explicit permanent-public acknowledgement", async () => {
    await assert.rejects(run("link", ["nostr", "begin", "--pubkey", "f".repeat(64)]), /exit:1/);
    assert.equal(fetchCalls, 0);
    assert.equal(JSON.parse(stderr[0]).code, "BAD_FLAG");
  });

  it("documents separate keys and durable public disclosure", async () => {
    await run("link", ["--help"]);
    assert.match(stdout.join("\n"), /keys? and run402 wallet stay separate/i);
    assert.match(stdout.join("\n"), /durable\s+public run402 proof/i);
    assert.match(stdout.join("\n"), /never accepts/i);
  });
});
