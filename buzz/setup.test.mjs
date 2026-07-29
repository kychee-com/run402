import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BuzzSetupError, runSetup } from "./scripts/setup.mjs";

const PUBKEY = "6b6951a5738dfe576d0c44bf7a5f8afe655005a156f9d3e648d81437c3f5ebbf";
const WALLET = "0x5450829a6d949aD9e641e5D9F84b3E093ef7fdB1";
const LINK_ID = "idlnk_test";
const PROOF = "{\"public_payload\":\"test\",\"wallet_signature\":\"0xproof\"}";

function ok(value = {}) {
  return { status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" };
}

function fail(code, message = code, nextActions = []) {
  return {
    status: 1,
    stdout: "",
    stderr: `${JSON.stringify({ code, message, mutation_state: "none", next_actions: nextActions })}\n`,
  };
}

function linkedIdentity() {
  return {
    identity_link_id: LINK_ID,
    public_subject: PUBKEY,
    display_subject: `npub1${"q".repeat(58)}`,
    effective_status: "active",
  };
}

function whoami(state, final = false) {
  const links = state.linked && !(final && state.finalMismatch) ? [linkedIdentity()] : [];
  return {
    principal: { id: "prin_agent", type: state.principalType },
    active_authenticator: {
      kind: state.authenticatorKind,
      public_subject: `eip155:8453:${WALLET}`,
    },
    linked_identities: links,
  };
}

function makeRunner(overrides = {}) {
  const state = {
    cliAvailable: true,
    compatible: true,
    initialized: true,
    linked: false,
    principalType: "agent",
    authenticatorKind: "siwx_eoa",
    beginFailure: null,
    helperFailure: null,
    completeFailure: null,
    finalMismatch: false,
    ...overrides,
  };
  const calls = [];
  let whoamiCalls = 0;

  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (command === "npm") {
      if (args.join(" ") === "prefix -g") return ok("/test-npm-global\n");
      state.cliAvailable = true;
      state.compatible = true;
      return ok("installed");
    }
    if (command === process.execPath) {
      if (state.helperFailure) return fail(state.helperFailure);
      const eventPath = args[args.indexOf("--event") + 1];
      writeFileSync(eventPath, JSON.stringify({
        content: PROOF,
        created_at: 1785258200,
        id: "e".repeat(64),
        kind: 1,
        pubkey: PUBKEY,
        sig: "f".repeat(128),
        tags: [],
      }));
      return ok({ event_id: "e".repeat(64) });
    }
    if (!command.endsWith("/bin/run402") || !state.cliAvailable) return { status: 127, stdout: "", stderr: "not found" };
    if (args[0] === "--version") return ok("run402 9.9.9\n");
    if (args.at(-1) === "--help") return state.compatible ? ok("help\n") : fail("BAD_COMMAND");
    if (args[0] === "init") {
      state.initialized = true;
      return ok({ initialized: true });
    }
    if (args.join(" ") === "org whoami") {
      if (!state.initialized) return fail("NO_ALLOWANCE", "Initialize", [{ type: "initialize_wallet" }]);
      whoamiCalls += 1;
      return ok(whoami(state, whoamiCalls > 1));
    }
    if (args.join(" ") === "identity link list") {
      return ok({ identity_links: state.linked ? [linkedIdentity()] : [] });
    }
    if (args.slice(0, 4).join(" ") === "identity link nostr begin") {
      if (state.beginFailure) return fail(state.beginFailure, "Challenge expired");
      return ok({ visibility: "public", nostr_pubkey: PUBKEY, proof_content: PROOF });
    }
    if (args.slice(0, 4).join(" ") === "identity link nostr complete") {
      if (state.completeFailure) return fail(state.completeFailure);
      state.linked = true;
      return ok(linkedIdentity());
    }
    if (args.slice(0, 3).join(" ") === "identity link show") {
      return ok({
        identity_link_id: LINK_ID,
        effective_status: "active",
        nostr_event: { pubkey: state.finalMismatch ? "0".repeat(64) : PUBKEY },
      });
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  return { state, calls, runner };
}

function count(calls, fragment) {
  return calls.filter((call) => call.join(" ").includes(fragment)).length;
}

function countExact(calls, command, args) {
  return calls.filter((call) => call[0] === command && call.slice(1).join(" ") === args).length;
}

function countRun402(calls, args) {
  return calls.filter((call) => call[0].endsWith("/bin/run402") && call.slice(1).join(" ") === args).length;
}

async function expectBlocked(overrides, code) {
  const fake = makeRunner(overrides);
  await assert.rejects(
    runSetup({ pubkey: PUBKEY, runner: fake.runner, temporaryRoot: mkdtempSync(join(tmpdir(), "buzz-setup-test-")) }),
    (error) => {
      assert.ok(error instanceof BuzzSetupError);
      assert.equal(error.code, code);
      assert.equal(error.mutationState, "none");
      assert.equal(typeof error.nextAction, "string");
      assert.ok(error.nextAction.length > 0);
      assert.equal(Object.keys(error.toJSON()).filter((key) => key === "next_action").length, 1);
      return true;
    },
  );
  return fake.calls;
}

describe("Run402 for Buzz setup state machine", () => {
  it("installs a missing global CLI, initializes an absent profile, links, verifies, and stops ready", async () => {
    const fake = makeRunner({ cliAvailable: false, initialized: false });
    const result = await runSetup({ pubkey: PUBKEY, runner: fake.runner });
    assert.equal(result.status, "ready");
    assert.equal(result.cli.state, "installed_or_updated");
    assert.equal(result.cli.installation, "user_global_npm");
    assert.equal(result.profile.state, "initialized");
    assert.equal(result.identity_link.state, "created");
    assert.equal(result.deployment, "none");
    assert.equal(result.run402_wallet, WALLET);
    assert.equal(result.principal_type, "agent");
    assert.deepEqual(result.next_action, { type: "offer_contextual_test", requires_approval: true });
    assert.equal(countExact(fake.calls, "npm", "install -g run402@latest"), 1);
    assert.equal(countRun402(fake.calls, "init"), 1);
    assert.equal(countRun402(fake.calls, `identity link nostr begin --pubkey ${PUBKEY} --visibility public`), 1);
    assert.equal(count(fake.calls, "identity link nostr complete --event-file"), 1);
  });

  it("updates a capability-incompatible CLI but reuses the initialized profile", async () => {
    const fake = makeRunner({ compatible: false });
    const result = await runSetup({ pubkey: PUBKEY, runner: fake.runner });
    assert.equal(result.cli.state, "installed_or_updated");
    assert.equal(result.profile.state, "reused");
    assert.equal(countExact(fake.calls, "npm", "install -g run402@latest"), 1);
    assert.equal(countRun402(fake.calls, "init"), 0);
  });

  it("is convergent when the compatible profile and intended link are already ready", async () => {
    const fake = makeRunner({ linked: true });
    const first = await runSetup({ pubkey: PUBKEY, runner: fake.runner });
    const second = await runSetup({ pubkey: PUBKEY, runner: fake.runner });
    assert.equal(first.identity_link.state, "reused");
    assert.equal(second.identity_link.state, "reused");
    assert.equal(countExact(fake.calls, "npm", "install -g run402@latest"), 0);
    assert.equal(countRun402(fake.calls, "init"), 0);
    assert.equal(count(fake.calls, "nostr begin --pubkey"), 0);
    assert.equal(count(fake.calls, "nostr complete --event-file"), 0);
  });

  it("refuses unexpected human or non-EOA principals before linking", async () => {
    const humanCalls = await expectBlocked({ principalType: "human" }, "RUN402_AGENT_PRINCIPAL_REQUIRED");
    const delegatedCalls = await expectBlocked({ authenticatorKind: "run402_agent_key" }, "RUN402_AGENT_PRINCIPAL_REQUIRED");
    assert.equal(count(humanCalls, "nostr begin --pubkey"), 0);
    assert.equal(count(delegatedCalls, "nostr begin --pubkey"), 0);
  });

  it("preserves stable errors for expired challenge, Buzz proof, completion, and final verification", async () => {
    await expectBlocked({ beginFailure: "IDENTITY_LINK_CHALLENGE_EXPIRED" }, "IDENTITY_LINK_CHALLENGE_EXPIRED");
    await expectBlocked({ helperFailure: "IDENTITY_LINK_UNSAFE_TAGS" }, "IDENTITY_LINK_UNSAFE_TAGS");
    await expectBlocked({ helperFailure: "WRONG_NOSTR_PRINCIPAL" }, "WRONG_NOSTR_PRINCIPAL");
    await expectBlocked({ completeFailure: "IDENTITY_LINK_INVALID_EVENT" }, "IDENTITY_LINK_INVALID_EVENT");
    await expectBlocked({ finalMismatch: true }, "IDENTITY_LINK_VERIFICATION_MISMATCH");
  });

  it("never runs setup-forbidden tier, project, provision, source, deploy, transfer, or delete commands", async () => {
    const fake = makeRunner({ cliAvailable: false, initialized: false });
    await runSetup({ pubkey: PUBKEY, runner: fake.runner });
    const transcript = fake.calls.map((call) => call.join(" ")).join("\n");
    for (const forbidden of ["tier set", "projects ", "provision", "deploy", "transfer", "delete", "generate"]) {
      assert.ok(!transcript.includes(forbidden), transcript);
    }
  });

  it("resolves the Run402 executable only through the user's global npm prefix", async () => {
    const fake = makeRunner({ linked: true });
    await runSetup({ pubkey: PUBKEY, runner: fake.runner });
    assert.equal(countExact(fake.calls, "npm", "prefix -g"), 1);
    const executableCalls = fake.calls.filter((call) => call[0].endsWith("/bin/run402"));
    assert.ok(executableCalls.length > 0);
    assert.ok(executableCalls.every((call) => call[0] === "/test-npm-global/bin/run402"));
  });

  it("returns only selected public readiness fields and redacts secret-bearing error text", async () => {
    const readyFake = makeRunner({ linked: true });
    const ready = await runSetup({ pubkey: PUBKEY, runner: readyFake.runner });
    const serialized = JSON.stringify(ready);
    for (const forbidden of ["private_key", "SIGN-IN-WITH-X", "X-PAYMENT", "Bearer ", "cookie"]) {
      assert.ok(!serialized.includes(forbidden));
    }

    const base = makeRunner({ linked: true });
    const runner = (command, args, options) => {
      if (command.endsWith("/bin/run402") && args.join(" ") === "identity link list") {
        return fail("IDENTITY_LINK_LIST_FAILED", "Bearer abc.secret", [{ type: "retry", cookie: "session-secret" }]);
      }
      return base.runner(command, args, options);
    };
    await assert.rejects(runSetup({ pubkey: PUBKEY, runner }), (error) => {
      const blocked = JSON.stringify(error.toJSON());
      assert.ok(!blocked.includes("abc.secret"));
      assert.ok(!blocked.includes("session-secret"));
      assert.equal(error.nextAction, "Inspect the active Run402 profile's identity links, then rerun setup.");
      return true;
    });
  });
});
