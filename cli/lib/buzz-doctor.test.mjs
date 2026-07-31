import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bech32 } from "@scure/base";
import {
  buildBuzzDoctorReport,
  BUZZ_DOCTOR_REPAIR_MATRIX,
  isPublicAddress,
  normalizeNostrSubject,
  parseBuzzDoctorArgs,
  pinnedLookup,
} from "./buzz-doctor.mjs";
import { BUZZ_DOCTOR_CHECK_ORDER, BUZZ_DOCTOR_CONTRACT, validateBuzzDoctorReport } from "./buzz-doctor-contract.mjs";

const SUBJECT = "6b6951a5738dfe576d0c44bf7a5f8afe655005a156f9d3e648d81437c3f5ebbf";
const OTHER_SUBJECT = "a".repeat(64);

function makeBuzzBin() {
  const directory = mkdtempSync(join(tmpdir(), "run402-buzz-doctor-"));
  const executable = join(directory, "buzz");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  return { directory, executable };
}

function commandOk(stdout = "") {
  return { status: 0, stdout, stderr: "" };
}

function commandError(code = "ENOENT") {
  return { status: null, stdout: "", stderr: "", error: Object.assign(new Error(code), { code }) };
}

function helpFor(args) {
  const key = args.join(" ");
  if (key === "--help") return "Buzz CLI — interact with a Buzz relay\nusers\nsocial\nErrors are JSON on stderr";
  if (key === "users get --help") return "Usage: buzz users get\n--pubkey\nOmit for your own profile";
  if (key === "social publish --help") return "Usage: buzz social publish\n--content";
  if (key === "social event --help") return "Usage: buzz social event\n--event";
  return null;
}

function healthyDependencies(overrides = {}) {
  const { directory, executable } = makeBuzzBin();
  const calls = [];
  const env = {
    SHELL: "/bin/sh",
    PATH: directory,
    BUZZ_RELAY_URL: "wss://community.example",
    RUN402_ACTIVE_WALLET_JSON: JSON.stringify({ name: "buzz-fizz", source: "flag", sourceDetail: "--wallet" }),
  };
  const runCommand = (command, args) => {
    calls.push([command, ...args]);
    if (command === "/bin/sh") return commandOk();
    if (command === "/opt/node") return commandOk("v22.12.0\n");
    if (command === executable || command.endsWith("/buzz")) {
      const help = helpFor(args);
      if (help !== null) return commandOk(help);
      if (args.join(" ") === "users get") return commandOk(JSON.stringify([{ pubkey: SUBJECT, display_name: "Fizz" }]));
    }
    return commandError();
  };
  return {
    expectedSubjectHex: SUBJECT,
    env,
    execPath: "/opt/node",
    cliExecutable: "/opt/run402",
    cwd: "/tmp",
    runCommand,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    pinnedRelayRead: async () => ({ ok: true, status: 200, elapsed_ms: 4 }),
    originProbe: async () => ({ ok: true, status: 200, elapsed_ms: 3 }),
    updateCheck: async () => ({ name: "cli_update", status: "ok" }),
    getActiveProfile: () => "buzz-fizz",
    profileExistsImpl: () => true,
    readMetaImpl: () => ({ name: "buzz-fizz", rail: "x402" }),
    apiOrigin: "https://api.run402.com",
    consoleOrigin: "https://console.run402.com",
    now: Date.parse("2026-07-31T12:00:00.000Z"),
    calls,
    ...overrides,
  };
}

describe("Buzz doctor argument and identity contract", () => {
  it("accepts an explicit hex or npub target and rejects malformed/repeated combinations before probing", () => {
    const npub = bech32.encode("npub", bech32.toWords(Buffer.from(SUBJECT, "hex")));
    assert.deepEqual(parseBuzzDoctorArgs(["--buzz", "--buzz-agent", SUBJECT]), { buzz: true, expectedSubjectHex: SUBJECT });
    assert.deepEqual(parseBuzzDoctorArgs(["--buzz", "--buzz-agent", npub]), { buzz: true, expectedSubjectHex: SUBJECT });
    assert.equal(parseBuzzDoctorArgs(["--buzz-agent", SUBJECT]).error.code, "BUZZ_MODE_REQUIRED");
    assert.equal(parseBuzzDoctorArgs(["--buzz", "--buzz-agent"]).error.code, "BAD_FLAG");
    assert.equal(parseBuzzDoctorArgs(["--buzz", "--buzz-agent", "not-an-npub"]).error.code, "BAD_BUZZ_AGENT");
    assert.equal(parseBuzzDoctorArgs(["--buzz", "--buzz-agent", SUBJECT, "--buzz-agent", SUBJECT]).error.code, "DUPLICATE_FLAG");
    assert.equal(normalizeNostrSubject(npub), SUBJECT);
  });
});

describe("Buzz doctor bounded zero-mutation runner", () => {
  it("returns the frozen ordered passing report without invoking a Buzz write or unrelated Run402 check", async () => {
    const dependencies = healthyDependencies();
    const report = await buildBuzzDoctorReport(dependencies);
    assert.equal(report.ok, true);
    assert.equal(report.mode, "buzz");
    assert.equal(report.mutation_state, "not_started");
    assert.deepEqual(report.checks.map((check) => check.name), BUZZ_DOCTOR_CHECK_ORDER);
    assert.ok(report.checks.every((check) => check.status === "ok"));
    assert.equal(report.checks.find((check) => check.name === "buzz_cli").value.version_status, "version_unknown_capabilities_ok");
    assert.equal(report.checks.find((check) => check.name === "buzz_agent_target").value.observed_subject_hex, SUBJECT);
    assert.equal(dependencies.calls.some((call) => call.includes("publish")), true, "publish help capability is expected");
    assert.equal(dependencies.calls.some((call) => call.join(" ").includes("publish --content")), false, "doctor must never publish");
    assert.equal(dependencies.calls.some((call) => call.includes("--version") && call[0].endsWith("buzz")), false, "released Buzz has no version flag");
    const validation = validateBuzzDoctorReport(report, {
      expectedSubjectHex: SUBJECT,
      walletProfile: "buzz-fizz",
      nodeExecutable: "/opt/node",
      run402Executable: "/opt/run402",
      relayOrigin: "wss://community.example",
      now: dependencies.now,
    });
    assert.deepEqual(validation, { valid: true, reason: null });
  });

  it("continues through independent shell, Node, client, origin, relay, target, and profile failures", async () => {
    const dependencies = healthyDependencies();
    dependencies.env.SHELL = "";
    dependencies.execPath = "/missing/node";
    dependencies.runCommand = (command, args) => {
      if (command === "/missing/node") return commandError();
      if (command.endsWith("/buzz")) {
        if (args.join(" ") === "--help") return commandOk("incompatible help");
        return commandError();
      }
      return commandError();
    };
    dependencies.originProbe = async () => ({ ok: false, status: 503, failure: "http_503" });
    dependencies.lookup = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    dependencies.profileExistsImpl = () => false;
    const report = await buildBuzzDoctorReport(dependencies);
    assert.equal(report.ok, false);
    const blocked = Object.fromEntries(report.checks.filter((check) => check.status === "blocked").map((check) => [check.name, check]));
    assert.equal(blocked.session_shell.code, "BUZZ_PREFLIGHT_SHELL_UNAVAILABLE");
    assert.equal(blocked.node_runtime.code, "BUZZ_PREFLIGHT_NODE_UNAVAILABLE");
    assert.equal(blocked.buzz_cli.code, "BUZZ_PREFLIGHT_BUZZ_CLI_INCOMPATIBLE");
    assert.equal(blocked.buzz_agent_target.code, "BUZZ_AGENT_TARGET_UNVERIFIED");
    assert.equal(blocked.run402_api.code, "BUZZ_PREFLIGHT_API_UNREACHABLE");
    assert.equal(blocked.run402_console.code, "BUZZ_PREFLIGHT_CONSOLE_UNREACHABLE");
    assert.equal(blocked.buzz_relay.code, "BUZZ_PREFLIGHT_RELAY_UNSAFE");
    assert.equal(blocked.wallet_profile.code, "BUZZ_PREFLIGHT_WALLET_PROFILE_NOT_FOUND");
    for (const check of Object.values(blocked)) assert.equal(check.next_actions.length, 1, check.name);
    assert.equal(blocked.buzz_cli.next_actions[0].surface, "buzz_settings");
    assert.equal("argv" in blocked.buzz_cli.next_actions[0], false);
    assert.deepEqual(blocked.wallet_profile.next_actions[0].argv, ["run402", "wallets", "new", "buzz-fizz"]);
  });

  it("fails closed when the released public self profile is absent or belongs to another agent", async () => {
    const absent = healthyDependencies();
    const originalAbsentRunner = absent.runCommand;
    absent.runCommand = (command, args, options) => args.join(" ") === "users get"
      ? commandOk("[]")
      : originalAbsentRunner(command, args, options);
    let report = await buildBuzzDoctorReport(absent);
    assert.equal(report.checks.find((check) => check.name === "buzz_agent_target").code, "BUZZ_AGENT_TARGET_UNVERIFIED");

    const mismatch = healthyDependencies();
    const originalMismatchRunner = mismatch.runCommand;
    mismatch.runCommand = (command, args, options) => args.join(" ") === "users get"
      ? commandOk(JSON.stringify([{ pubkey: OTHER_SUBJECT }]))
      : originalMismatchRunner(command, args, options);
    report = await buildBuzzDoctorReport(mismatch);
    const target = report.checks.find((check) => check.name === "buzz_agent_target");
    assert.equal(target.code, "BUZZ_AGENT_TARGET_MISMATCH");
    assert.equal(target.value.expected_subject_hex, SUBJECT);
    assert.equal(target.value.observed_subject_hex, OTHER_SUBJECT);
  });

  it("treats compatible stale Run402 as warning and preserves executable argv guidance", async () => {
    const dependencies = healthyDependencies({
      updateCheck: async () => ({
        name: "cli_update",
        status: "warning",
        value: { next_actions: [{ argv: ["npm", "install", "-g", "run402@latest"], cwd: "/tmp" }] },
      }),
    });
    const report = await buildBuzzDoctorReport(dependencies);
    const check = report.checks.find((entry) => entry.name === "run402_cli");
    assert.equal(check.status, "warning");
    assert.equal(check.code, "BUZZ_PREFLIGHT_RUN402_UPDATE_AVAILABLE");
    assert.deepEqual(check.next_actions[0].argv, ["npm", "install", "-g", "run402@latest"]);
    assert.equal(report.ok, true);
  });

  it("rejects private, loopback, link-local, mapped, and documentation addresses", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.0.2.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1"]) {
      assert.equal(isPublicAddress(address), false, address);
    }
    assert.equal(isPublicAddress("93.184.216.34"), true);
    assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  });

  it("pins relay connections to the validated address and exhaustively maps every stable code", () => {
    const callbackResults = [];
    const lookup = pinnedLookup({ address: "93.184.216.34", family: 4 }, "community.example");
    lookup("community.example", {}, (error, address, family) => callbackResults.push({ error, address, family }));
    lookup("changed.example", {}, (error, address, family) => callbackResults.push({ error, address, family }));
    assert.deepEqual(callbackResults[0], { error: null, address: "93.184.216.34", family: 4 });
    assert.equal(callbackResults[1].error.message, "relay_hostname_changed");
    assert.equal(callbackResults[1].address, undefined);

    const contractCodes = Object.values(BUZZ_DOCTOR_CONTRACT.codes_by_check).flat().sort();
    assert.deepEqual(Object.keys(BUZZ_DOCTOR_REPAIR_MATRIX).sort(), contractCodes);
  });
});
