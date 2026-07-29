import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const tempDir = mkdtempSync(join(tmpdir(), "run402-identity-cli-"));
const vector = JSON.parse(readFileSync(
  new URL("./buzz/fixtures/identity-link-v1-golden.json", import.meta.url),
  "utf8",
));
const eventFile = join(tempDir, "event.json");
writeFileSync(eventFile, JSON.stringify(vector.nip01.event));

const proof = vector.expected_public_proof_response;
const challenge = {
  identity_link_challenge_id: "ilc_01K1BW4R2MZ7B4M5SH9XJ2C3DT",
  proof_protocol: "run402.identity-link.nostr.v1",
  visibility: "public",
  disclosure: {
    permanence: "public_and_durable",
    warning: "The dual proof remains public after revocation.",
  },
  proof_content: vector.event_content,
  wallet_address: vector.eip191.recovered_address,
  wallet_signature: vector.eip191.signature,
};

let sdkError = null;
let calls = [];
let sdkModes = [];

function maybe(value) {
  if (sdkError) throw sdkError;
  return Promise.resolve(value);
}

mock.module("./cli/lib/sdk.mjs", {
  namedExports: {
    getSdk: (options) => {
      sdkModes.push(options);
      return {
        identityLinks: {
          nostr: {
            begin: (input) => { calls.push({ operation: "begin", input }); return maybe(challenge); },
            complete: (input) => { calls.push({ operation: "complete", input }); return maybe(proof); },
          },
          list: () => { calls.push({ operation: "list" }); return maybe({ identity_links: [], next_cursor: null }); },
          getProof: (id) => { calls.push({ operation: "show", id }); return maybe(proof); },
          revoke: (id) => { calls.push({ operation: "revoke", id }); return maybe({ ...proof, status: "revoked", effective_status: "revoked", revoked_at: "2026-07-28T18:00:00.000Z" }); },
        },
      };
    },
  },
});

const { run } = await import("./cli/lib/identity.mjs");
const originalExit = process.exit;
const originalError = console.error;
const originalLog = console.log;
let stderr = [];
let stdout = [];

before(() => {
  process.exit = (code) => { throw new Error(`exit:${code}`); };
  console.error = (...args) => stderr.push(args.map(String).join(" "));
  console.log = (...args) => stdout.push(args.map(String).join(" "));
});

after(() => {
  process.exit = originalExit;
  console.error = originalError;
  console.log = originalLog;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  sdkError = null;
  calls = [];
  sdkModes = [];
  stderr = [];
  stdout = [];
});

function stdoutJson() {
  assert.equal(stderr.length, 0);
  return JSON.parse(stdout.join("\n"));
}

describe("identity link CLI output contract", () => {
  it("prints the explicit permanent-public challenge and uses wallet auth", async () => {
    await run("link", ["nostr", "begin", "--pubkey", vector.nip01.event.pubkey, "--visibility", "public", "--idempotency-key", "buzz-1"]);
    const output = stdoutJson();
    assert.equal(output.disclosure.permanence, "public_and_durable");
    assert.match(output.disclosure.warning, /public after revocation/i);
    assert.deepEqual(calls, [{
      operation: "begin",
      input: { nostrPubkey: vector.nip01.event.pubkey, visibility: "public", idempotencyKey: "buzz-1" },
    }]);
    assert.deepEqual(sdkModes, [{ authMode: "wallet" }]);
  });

  it("prints JSON-only happy paths for complete/list/show/revoke and keeps public show unauthenticated", async () => {
    await run("link", ["nostr", "complete", "--event-file", eventFile]);
    assert.equal(stdoutJson().identity_link_id, proof.identity_link_id);
    assert.equal(calls[0].input.rawEvent, JSON.stringify(vector.nip01.event));

    stdout = [];
    await run("link", ["list"]);
    assert.deepEqual(stdoutJson(), { identity_links: [], next_cursor: null });

    stdout = [];
    await run("link", ["show", proof.identity_link_id]);
    assert.equal(stdoutJson().effective_status, "active");

    stdout = [];
    await run("link", ["revoke", proof.identity_link_id]);
    assert.equal(stdoutJson().effective_status, "revoked");
    assert.deepEqual(sdkModes.map((entry) => entry.authMode), ["wallet", "wallet", "none", "wallet"]);
  });

  it("renders revoked and principal-inactive retained proofs without implying authority", async () => {
    sdkError = null;
    const inactive = { ...proof, status: "active", effective_status: "principal_inactive" };
    calls = [];
    // Override the one-shot value through the shared proof object returned by
    // the mocked surface, then restore it after the assertion.
    const original = proof.effective_status;
    proof.effective_status = inactive.effective_status;
    await run("link", ["show", proof.identity_link_id]);
    const output = stdoutJson();
    proof.effective_status = original;
    assert.equal(output.effective_status, "principal_inactive");
    assert.equal(output.owner, undefined);
    assert.equal(output.authorization, undefined);
  });

  for (const scenario of [
    ["incomplete event", 400, "IDENTITY_LINK_INVALID_EVENT"],
    ["noncanonical wrapper", 400, "IDENTITY_LINK_NONCANONICAL"],
    ["conditioned or malformed tag", 422, "IDENTITY_LINK_INVALID_NIP_OA"],
    ["expired challenge", 409, "IDENTITY_LINK_CHALLENGE_EXPIRED"],
    ["active-link conflict", 409, "IDENTITY_LINK_SUBJECT_CONFLICT"],
    ["different-event replay", 409, "IDENTITY_LINK_NONCE_REPLAYED"],
  ]) {
    it(`preserves the structured ${scenario[0]} failure`, async () => {
      sdkError = {
        status: scenario[1],
        body: {
          code: scenario[2],
          message: scenario[0],
          retryable: false,
          safe_to_retry: scenario[2] === "IDENTITY_LINK_CHALLENGE_EXPIRED",
          mutation_state: "not_started",
          next_actions: [{ type: "identity_link_begin" }],
        },
      };
      await assert.rejects(run("link", ["nostr", "complete", "--event-file", eventFile]), /exit:1/);
      assert.equal(stdout.length, 0);
      const error = JSON.parse(stderr[0]);
      assert.equal(error.status, "error");
      assert.equal(error.http, scenario[1]);
      assert.equal(error.code, scenario[2]);
      assert.equal(error.mutation_state, "not_started");
      assert.deepEqual(error.next_actions, [{ type: "identity_link_begin" }]);
    });
  }

  it("prints a successful event-id retry as the same proof without claiming a new link", async () => {
    await run("link", ["nostr", "complete", "--event-file", eventFile]);
    const output = stdoutJson();
    assert.equal(output.identity_link_id, proof.identity_link_id);
    assert.equal(output.created, undefined);
  });
});
