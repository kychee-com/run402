import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  BUZZ_DOCTOR_CHECK_ORDER,
  BUZZ_DOCTOR_CONTRACT,
  BUZZ_DOCTOR_CONTRACT_ID,
  validateBuzzDoctorAction,
  validateBuzzDoctorReport,
} from "./buzz-doctor-contract.mjs";

const FIXTURE = JSON.parse(readFileSync(new URL("../../buzz/fixtures/buzz-v0.5.2-cli-capabilities.json", import.meta.url), "utf8"));

function shellAction() {
  return {
    type: "upgrade_client",
    surface: "shell",
    command: "npm install -g run402@latest",
    argv: ["npm", "install", "-g", "run402@latest"],
    why: "Install the compatible Run402 CLI.",
    safe_to_auto_execute: true,
    requires_approval: false,
    destructive: false,
    idempotent: true,
    spend_impact: { currency: "USD", max_amount: "0" },
  };
}

function passingReport(now) {
  return {
    ok: true,
    mode: "buzz",
    contract_id: BUZZ_DOCTOR_CONTRACT_ID,
    generated_at: new Date(now).toISOString(),
    mutation_state: "not_started",
    binding: {
      contract_id: BUZZ_DOCTOR_CONTRACT_ID,
      expected_subject_hex: "a".repeat(64),
      wallet_profile: "buzz-fizz",
      node_executable: "/usr/local/bin/node",
      run402_executable: "/usr/local/bin/run402",
      relay_origin: "wss://community.example",
    },
    checks: BUZZ_DOCTOR_CHECK_ORDER.map((name) => ({ name, status: "ok" })),
    telemetry: { status: "disabled" },
  };
}

describe("Buzz doctor v1 frozen contract", () => {
  it("freezes the ordered checks, flags, statuses, exit streams, freshness binding, and zero-mutation verdict", () => {
    assert.equal(BUZZ_DOCTOR_CONTRACT_ID, "run402.buzz-doctor.v1");
    assert.deepEqual(BUZZ_DOCTOR_CHECK_ORDER, [
      "session_shell", "node_runtime", "run402_cli", "buzz_cli", "buzz_agent_target",
      "run402_api", "run402_console", "buzz_relay", "wallet_profile",
    ]);
    assert.deepEqual(BUZZ_DOCTOR_CONTRACT.statuses, ["ok", "warning", "blocked"]);
    assert.deepEqual(BUZZ_DOCTOR_CONTRACT.flags, { mode: "--buzz", agent: "--buzz-agent", profile: "--wallet" });
    assert.deepEqual(BUZZ_DOCTOR_CONTRACT.exit_behavior, {
      passed_or_warning_only: 0,
      completed_with_blocked_checks: 1,
      usage_error: 1,
      completed_report_stream: "stdout",
      usage_error_stream: "stderr",
    });
    assert.equal(BUZZ_DOCTOR_CONTRACT.freshness.max_age_seconds, 60);
    assert.deepEqual(BUZZ_DOCTOR_CONTRACT.setup_rejection_codes, [
      "BUZZ_PREFLIGHT_REPORT_INVALID",
      "BUZZ_PREFLIGHT_REPORT_STALE",
      "BUZZ_PREFLIGHT_REPORT_MISMATCH",
    ]);
    assert.equal(BUZZ_DOCTOR_CONTRACT.zero_mutation.mutation_state, "not_started");
    assert.ok(BUZZ_DOCTOR_CONTRACT.zero_mutation.forbidden.includes("buzz_event_publish"));
    assert.ok(BUZZ_DOCTOR_CONTRACT.zero_mutation.forbidden.includes("run402_identity_link_mutation"));
  });

  it("requires exactly one complete destination-specific action on every actionable check", () => {
    assert.equal(validateBuzzDoctorAction(shellAction()), null);
    assert.equal(validateBuzzDoctorAction({ ...shellAction(), argv: undefined }), "action_argv_invalid");
    const chat = { ...shellAction(), surface: "buzz_chat", command: "@Fizz restart setup" };
    delete chat.argv;
    assert.equal(validateBuzzDoctorAction(chat), null);
    assert.equal(validateBuzzDoctorAction({ ...chat, argv: ["echo", "wrong"] }), "action_argv_forbidden");
  });

  it("rejects stale, reordered, mismatched, edited, or verdict-inconsistent reports", () => {
    const now = Date.parse("2026-07-31T12:00:00.000Z");
    const expected = {
      expectedSubjectHex: "a".repeat(64),
      walletProfile: "buzz-fizz",
      nodeExecutable: "/usr/local/bin/node",
      run402Executable: "/usr/local/bin/run402",
      relayOrigin: "wss://community.example",
      now,
    };
    assert.deepEqual(validateBuzzDoctorReport(passingReport(now), expected), { valid: true, reason: null });
    assert.equal(validateBuzzDoctorReport(passingReport(now - 61_000), expected).reason, "report_stale");
    const reordered = passingReport(now);
    reordered.checks.reverse();
    assert.equal(validateBuzzDoctorReport(reordered, expected).reason, "check_order_mismatch");
    assert.equal(validateBuzzDoctorReport(passingReport(now), { ...expected, walletProfile: "buzz-honey" }).reason, "binding_wallet_profile_mismatch");
    const edited = passingReport(now);
    edited.checks[0] = { name: "session_shell", status: "blocked", code: "MADE_UP", next_actions: [shellAction()] };
    assert.equal(validateBuzzDoctorReport(edited, expected).reason, "check_code_invalid");
    const falseVerdict = passingReport(now);
    falseVerdict.ok = false;
    assert.equal(validateBuzzDoctorReport(falseVerdict, expected).reason, "verdict_mismatch");
  });

  it("freezes released Buzz v0.5.2 as capability-first with JSON outputs and no version flag", () => {
    assert.equal(FIXTURE.fixture_id, "buzz-cli-v0.5.2-capabilities");
    assert.equal(FIXTURE.buzz_release.release_tag_commit, "3e48f1b2365d326ee1c9582448d86a99b44ecd5d");
    assert.deepEqual(FIXTURE.help_probes.map((probe) => probe.argv.slice(1)), [
      ["--help"],
      ["users", "get", "--help"],
      ["social", "publish", "--help"],
      ["social", "event", "--help"],
    ]);
    assert.equal(FIXTURE.version_probe.supported, false);
    assert.equal(FIXTURE.version_probe.stderr_json.error, "user_error");
    assert.equal(FIXTURE.json_contract.default_output_format, "json");
    assert.equal(FIXTURE.json_contract.users_get_success_stdout.type, "array");
    assert.equal(FIXTURE.managed_sidecar.public_package_manager_install, false);
    assert.equal(FIXTURE.managed_sidecar.repair_surface, "buzz_settings");
    assert.equal(FIXTURE.public_self_observation.requires_private_key_value_inspection, false);
    assert.equal(FIXTURE.write_surface_policy.publish_is_never_invoked_by_doctor, true);
  });
});
