import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BuzzSetupError, runSetup } from "./scripts/setup.mjs";

const PUBKEY = "6b6951a5738dfe576d0c44bf7a5f8afe655005a156f9d3e648d81437c3f5ebbf";
const CONFLICTING_PUBKEY = "a".repeat(64);
const PROFILE = "buzz-fizz";
const AMBIENT_PROFILE = "kychon";
const WALLET = "0x5450829a6d949aD9e641e5D9F84b3E093ef7fdB1";
const AMBIENT_WALLET = "0x1111111111111111111111111111111111111111";
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

function linkedIdentity(pubkey = PUBKEY, identityLinkId = LINK_ID) {
  return {
    identity_link_id: identityLinkId,
    kind: "nostr_nip01",
    public_subject: pubkey,
    display_subject: pubkey === PUBKEY ? `npub1${"q".repeat(58)}` : `npub1${"z".repeat(58)}`,
    effective_status: "active",
  };
}

function activeLinks(state, final = false) {
  const links = [];
  if (state.linked && !(final && state.finalMismatch)) links.push(linkedIdentity());
  if (state.conflictingPubkey) links.push(linkedIdentity(state.conflictingPubkey, "idlnk_other"));
  return links;
}

function whoami(state, final = false, address = WALLET, principalType = state.principalType) {
  return {
    principal: { id: "prin_agent", type: principalType },
    active_authenticator: {
      kind: state.authenticatorKind,
      public_subject: `eip155:8453:${address}`,
    },
    linked_identities: activeLinks(state, final),
  };
}

function makeRunner(overrides = {}) {
  const state = {
    cliAvailable: true,
    compatible: true,
    profileExists: true,
    initialized: true,
    linked: false,
    conflictingPubkey: null,
    principalType: "agent",
    authenticatorKind: "siwx_eoa",
    targetProfile: PROFILE,
    ambientProfile: AMBIENT_PROFILE,
    beginFailure: null,
    helperFailure: null,
    completeFailure: null,
    finalMismatch: false,
    ...overrides,
  };
  const calls = [];
  const timeline = [];
  let whoamiCalls = 0;

  const runner = (command, args) => {
    calls.push([command, ...args]);
    timeline.push({ type: "command", command, args: [...args] });
    if (command === "npm") {
      if (args.join(" ") === "prefix -g") return ok("/test-npm-global\n");
      if (args.join(" ") === "list -g run402 --depth=0 --json") {
        return state.cliAvailable ? ok({ dependencies: { run402: { version: "9.9.9" } } }) : fail("NPM_PACKAGE_NOT_FOUND");
      }
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

    const hasExplicitWallet = args[0] === "--wallet";
    const selectedWallet = hasExplicitWallet ? args[1] : state.ambientProfile;
    const commandArgs = hasExplicitWallet ? args.slice(2) : args;

    if (commandArgs.join(" ") === "wallets current") {
      if (selectedWallet === state.targetProfile) {
        return ok({
          local_label: state.targetProfile,
          source: "flag",
          source_detail: "--wallet",
          address: state.profileExists ? WALLET : null,
          server_label: state.profileExists ? state.targetProfile : null,
          warnings: [],
        });
      }
      return ok({
        local_label: selectedWallet,
        source: "env",
        source_detail: "RUN402_WALLET",
        address: AMBIENT_WALLET,
        server_label: selectedWallet,
        warnings: [],
      });
    }
    if (commandArgs[0] === "init") {
      state.initialized = true;
      return ok({ initialized: true });
    }
    if (commandArgs.join(" ") === "org whoami") {
      if (selectedWallet !== state.targetProfile) return ok(whoami(state, false, AMBIENT_WALLET, "human"));
      if (!state.initialized) return fail("NO_ALLOWANCE", "Initialize", [{ type: "initialize_wallet" }]);
      whoamiCalls += 1;
      return ok(whoami(state, whoamiCalls > 1));
    }
    if (commandArgs.join(" ") === "identity link list") {
      return ok({ identity_links: activeLinks(state) });
    }
    if (commandArgs.slice(0, 4).join(" ") === "identity link nostr begin") {
      if (state.beginFailure) return fail(state.beginFailure, "Challenge expired");
      return ok({ visibility: "public", nostr_pubkey: PUBKEY, proof_content: PROOF });
    }
    if (commandArgs.slice(0, 4).join(" ") === "identity link nostr complete") {
      if (state.completeFailure) return fail(state.completeFailure);
      state.linked = true;
      return ok(linkedIdentity());
    }
    if (commandArgs.slice(0, 3).join(" ") === "identity link show") {
      return ok({
        identity_link_id: LINK_ID,
        effective_status: "active",
        nostr_event: { pubkey: state.finalMismatch ? "0".repeat(64) : PUBKEY },
      });
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  return { state, calls, timeline, runner };
}

function count(calls, fragment) {
  return calls.filter((call) => call.join(" ").includes(fragment)).length;
}

function countMutation(calls, fragment) {
  return calls.filter((call) => call.join(" ").includes(fragment) && call.at(-1) !== "--help").length;
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
    runSetup({
      pubkey: PUBKEY,
      wallet: PROFILE,
      runner: fake.runner,
      reporter: () => {},
      temporaryRoot: mkdtempSync(join(tmpdir(), "buzz-setup-test-")),
    }),
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
  it("installs a missing global CLI, initializes the existing named profile, links, verifies, and stops ready", async () => {
    const fake = makeRunner({ cliAvailable: false, initialized: false });
    const result = await runSetup({ pubkey: PUBKEY, wallet: PROFILE, runner: fake.runner, reporter: () => {} });
    assert.equal(result.status, "ready");
    assert.equal(result.cli.state, "installed_or_updated");
    assert.equal(result.cli.installation, "user_global_npm");
    assert.deepEqual(result.profile, {
      state: "initialized",
      profile_label: PROFILE,
      wallet_address: WALLET,
      selection_source: "explicit_argument",
    });
    assert.equal(result.identity_link.state, "created");
    assert.equal(result.deployment, "none");
    assert.equal(result.run402_wallet, WALLET);
    assert.equal(result.principal_type, "agent");
    assert.deepEqual(result.next_action, { type: "offer_contextual_test", requires_approval: true });
    assert.equal(countExact(fake.calls, "npm", "install -g run402@latest"), 1);
    assert.equal(countRun402(fake.calls, `--wallet ${PROFILE} wallets current`), 1);
    assert.equal(countRun402(fake.calls, `--wallet ${PROFILE} init`), 1);
    assert.equal(countRun402(fake.calls, `--wallet ${PROFILE} identity link nostr begin --pubkey ${PUBKEY} --visibility public`), 1);
    assert.equal(count(fake.calls, `--wallet ${PROFILE} identity link nostr complete --event-file`), 1);
  });

  it("updates a capability-incompatible CLI but reuses the initialized profile", async () => {
    const fake = makeRunner({ compatible: false });
    const result = await runSetup({ pubkey: PUBKEY, wallet: PROFILE, runner: fake.runner, reporter: () => {} });
    assert.equal(result.cli.state, "installed_or_updated");
    assert.equal(result.profile.state, "reused");
    assert.equal(countExact(fake.calls, "npm", "install -g run402@latest"), 1);
    assert.equal(countRun402(fake.calls, `--wallet ${PROFILE} init`), 0);
  });

  it("is convergent when the compatible profile and intended link are already ready", async () => {
    const fake = makeRunner({ linked: true });
    const first = await runSetup({ pubkey: PUBKEY, wallet: PROFILE, runner: fake.runner, reporter: () => {} });
    const second = await runSetup({ pubkey: PUBKEY, wallet: PROFILE, runner: fake.runner, reporter: () => {} });
    assert.equal(first.identity_link.state, "reused");
    assert.equal(second.identity_link.state, "reused");
    assert.equal(countExact(fake.calls, "npm", "install -g run402@latest"), 0);
    assert.equal(countRun402(fake.calls, `--wallet ${PROFILE} init`), 0);
    assert.equal(count(fake.calls, "nostr begin --pubkey"), 0);
    assert.equal(count(fake.calls, "nostr complete --event-file"), 0);
  });

  it("requires an explicit named wallet before invoking npm or Run402", async () => {
    let calls = 0;
    await assert.rejects(
      runSetup({ pubkey: PUBKEY, runner: () => { calls += 1; return ok(); }, reporter: () => {} }),
      (error) => error instanceof BuzzSetupError && error.code === "BAD_USAGE",
    );
    assert.equal(calls, 0);
  });

  it("requires the exact profile to exist and never typo-creates it", async () => {
    const fake = makeRunner({ profileExists: false });
    await assert.rejects(
      runSetup({ pubkey: PUBKEY, wallet: PROFILE, runner: fake.runner, reporter: () => {} }),
      (error) => {
        assert.equal(error.code, "RUN402_WALLET_NOT_FOUND");
        assert.equal(error.mutationState, "none");
        assert.match(error.nextAction, new RegExp(`run402 wallets new ${PROFILE}`));
        return true;
      },
    );
    assert.equal(count(fake.calls, " wallets new "), 0);
    assert.equal(countRun402(fake.calls, `--wallet ${PROFILE} init`), 0);
    assert.equal(countMutation(fake.calls, "identity link nostr begin"), 0);
  });

  it("pins buzz-fizz when ambient kychon exists", async () => {
    const fake = makeRunner({ linked: true, ambientProfile: AMBIENT_PROFILE });
    const result = await runSetup({ pubkey: PUBKEY, wallet: PROFILE, runner: fake.runner, reporter: () => {} });
    const profileSensitiveCalls = fake.calls.filter((call) =>
      call[0].endsWith("/bin/run402"),
    );
    assert.ok(profileSensitiveCalls.length > 0);
    assert.ok(profileSensitiveCalls.every((call) => call[1] === "--wallet" && call[2] === PROFILE));
    assert.equal(result.profile.profile_label, PROFILE);
    assert.equal(result.profile.wallet_address, WALLET);
    assert.equal(result.profile.selection_source, "explicit_argument");
    assert.equal(count(fake.calls, `--wallet ${AMBIENT_PROFILE}`), 0);
  });

  it("reports explicit selection before beginning a public link", async () => {
    const fake = makeRunner();
    const events = [];
    const result = await runSetup({
      pubkey: PUBKEY,
      wallet: PROFILE,
      runner: fake.runner,
      reporter: (event) => {
        events.push(event);
        fake.timeline.push({ type: "progress", event });
      },
    });
    assert.deepEqual(events, [{
      status: "progress",
      stage: "profile_selection",
      mutation_state: "none",
      profile_label: PROFILE,
      wallet_address: WALLET,
      selection_source: "explicit_argument",
    }]);
    const reportIndex = fake.timeline.findIndex((entry) => entry.type === "progress");
    const beginIndex = fake.timeline.findIndex((entry) =>
      entry.type === "command" && entry.args.includes("begin") && entry.args.at(-1) !== "--help",
    );
    assert.ok(reportIndex >= 0 && beginIndex > reportIndex);
    assert.deepEqual(result.profile, {
      state: "reused",
      profile_label: PROFILE,
      wallet_address: WALLET,
      selection_source: "explicit_argument",
    });
  });

  it("refuses another active Nostr identity before creating a challenge", async () => {
    const calls = await expectBlocked({ conflictingPubkey: CONFLICTING_PUBKEY }, "RUN402_NOSTR_IDENTITY_CONFLICT");
    assert.equal(countMutation(calls, "identity link nostr begin"), 0);
    assert.equal(countMutation(calls, "identity link nostr complete"), 0);
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
    await runSetup({ pubkey: PUBKEY, wallet: PROFILE, runner: fake.runner, reporter: () => {} });
    const transcript = fake.calls.map((call) => call.join(" ")).join("\n");
    for (const forbidden of ["tier set", "projects ", "provision", "deploy", "transfer", "delete", "generate"]) {
      assert.ok(!transcript.includes(forbidden), transcript);
    }
  });

  it("resolves the Run402 executable only through the user's global npm prefix", async () => {
    const fake = makeRunner({ linked: true });
    await runSetup({ pubkey: PUBKEY, wallet: PROFILE, runner: fake.runner, reporter: () => {} });
    assert.equal(countExact(fake.calls, "npm", "prefix -g"), 1);
    const executableCalls = fake.calls.filter((call) => call[0].endsWith("/bin/run402"));
    assert.ok(executableCalls.length > 0);
    assert.ok(executableCalls.every((call) => call[0] === "/test-npm-global/bin/run402"));
  });

  it("returns only selected public readiness fields and redacts secret-bearing error text", async () => {
    const readyFake = makeRunner({ linked: true });
    const ready = await runSetup({ pubkey: PUBKEY, wallet: PROFILE, runner: readyFake.runner, reporter: () => {} });
    const serialized = JSON.stringify(ready);
    for (const forbidden of ["private_key", "SIGN-IN-WITH-X", "X-PAYMENT", "Bearer ", "cookie"]) {
      assert.ok(!serialized.includes(forbidden));
    }

    const base = makeRunner({ linked: true });
    const runner = (command, args, options) => {
      if (command.endsWith("/bin/run402") && args.join(" ") === `--wallet ${PROFILE} identity link list`) {
        return fail("IDENTITY_LINK_LIST_FAILED", "Bearer abc.secret", [{ type: "retry", cookie: "session-secret" }]);
      }
      return base.runner(command, args, options);
    };
    await assert.rejects(runSetup({ pubkey: PUBKEY, wallet: PROFILE, runner, reporter: () => {} }), (error) => {
      const blocked = JSON.stringify(error.toJSON());
      assert.ok(!blocked.includes("abc.secret"));
      assert.ok(!blocked.includes("session-secret"));
      assert.equal(error.nextAction, "Inspect the active Run402 profile's identity links, then rerun setup.");
      return true;
    });
  });
});
