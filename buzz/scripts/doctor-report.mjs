import { readFileSync } from "node:fs";

const CONTRACT = JSON.parse(readFileSync(
  new URL("../fixtures/run402-buzz-doctor-v1-contract.json", import.meta.url),
  "utf8",
));

export function validatePassingDoctorReport(report, {
  wallet,
  nodeExecutable,
  run402Executable,
  relayUrl,
  now = Date.now(),
} = {}) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return failure("report_not_object");
  if (report.contract_id !== CONTRACT.contract_id || report.mode !== "buzz") return failure("contract_mismatch");
  if (report.mutation_state !== CONTRACT.zero_mutation.mutation_state) return failure("mutation_state_invalid");
  if (!Array.isArray(report.checks) || report.checks.length !== CONTRACT.check_order.length) return failure("check_count_mismatch");
  for (let index = 0; index < CONTRACT.check_order.length; index += 1) {
    const check = report.checks[index];
    if (!check || check.name !== CONTRACT.check_order[index]) return failure("check_order_mismatch");
    if (!CONTRACT.statuses.includes(check.status)) return failure("check_status_invalid");
    if (check.status === "blocked") return failure("report_blocked", { blocked_check: check });
    if (check.status === "warning") {
      if (!CONTRACT.codes_by_check[check.name]?.includes(check.code)) return failure("warning_code_invalid");
      if (!Array.isArray(check.next_actions) || check.next_actions.length !== 1) return failure("warning_action_invalid");
    } else if ("next_actions" in check) {
      return failure("passing_action_forbidden");
    }
  }
  if (report.ok !== true) return failure("verdict_mismatch");
  const generatedAt = Date.parse(report.generated_at);
  if (!Number.isFinite(generatedAt)) return failure("generated_at_invalid");
  if (generatedAt > now || now - generatedAt > CONTRACT.freshness.max_age_seconds * 1000) return failure("report_stale");
  const binding = report.binding;
  if (!binding || typeof binding !== "object") return failure("binding_missing");
  const expectedRelayOrigin = relayOrigin(relayUrl);
  const expected = {
    contract_id: CONTRACT.contract_id,
    wallet_profile: wallet,
    node_executable: nodeExecutable,
    run402_executable: run402Executable,
    relay_origin: expectedRelayOrigin,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (binding[field] !== value) return failure(`binding_${field}_mismatch`);
  }
  if (!/^[0-9a-f]{64}$/.test(binding.expected_subject_hex ?? "")) return failure("binding_expected_subject_hex_invalid");
  const target = report.checks.find((check) => check.name === "buzz_agent_target");
  if (target?.value?.expected_subject_hex !== binding.expected_subject_hex
    || target?.value?.observed_subject_hex !== binding.expected_subject_hex) {
    return failure("binding_expected_subject_hex_mismatch");
  }
  return { valid: true, reason: null, blockedCheck: null };
}

export function setupRejectionCode(reason) {
  if (reason === "report_stale" || reason === "generated_at_invalid") return "BUZZ_PREFLIGHT_REPORT_STALE";
  if (reason === "report_blocked") return null;
  if (typeof reason === "string" && (reason.startsWith("binding_") || reason === "contract_mismatch" || reason === "check_order_mismatch")) {
    return "BUZZ_PREFLIGHT_REPORT_MISMATCH";
  }
  return "BUZZ_PREFLIGHT_REPORT_INVALID";
}

export function rerunDoctorAction(wallet, subject) {
  const argv = ["run402", "--wallet", wallet, "doctor", "--buzz", "--buzz-agent", subject];
  return {
    type: "rerun_buzz_doctor",
    surface: "shell",
    command: argv.join(" "),
    argv,
    why: "Produce a fresh unedited Buzz doctor report for this exact agent and profile before setup mutation.",
    safe_to_auto_execute: true,
    requires_approval: false,
    destructive: false,
    idempotent: true,
    spend_impact: { currency: "USD", max_amount: "0" },
  };
}

function relayOrigin(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try { return new URL(value).origin; }
  catch { return null; }
}

function failure(reason, { blocked_check: blockedCheck = null } = {}) {
  return { valid: false, reason, blockedCheck };
}
