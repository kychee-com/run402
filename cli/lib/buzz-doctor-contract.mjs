import { readFileSync } from "node:fs";

const CONTRACT_URL = new URL("../fixtures/run402-buzz-doctor-v1-contract.json", import.meta.url);

export const BUZZ_DOCTOR_CONTRACT = deepFreeze(JSON.parse(readFileSync(CONTRACT_URL, "utf8")));
export const BUZZ_DOCTOR_CONTRACT_ID = BUZZ_DOCTOR_CONTRACT.contract_id;
export const BUZZ_DOCTOR_CHECK_ORDER = BUZZ_DOCTOR_CONTRACT.check_order;
export const BUZZ_DOCTOR_STATUSES = new Set(BUZZ_DOCTOR_CONTRACT.statuses);
export const BUZZ_DOCTOR_ACTION_SURFACES = new Set(BUZZ_DOCTOR_CONTRACT.next_action.surfaces);
export const BUZZ_DOCTOR_MAX_AGE_MS = BUZZ_DOCTOR_CONTRACT.freshness.max_age_seconds * 1000;

export function validateBuzzDoctorAction(action, { surface } = {}) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return "action_not_object";
  for (const field of BUZZ_DOCTOR_CONTRACT.next_action.required_fields) {
    if (!(field in action)) return `action_missing_${field}`;
  }
  if (!BUZZ_DOCTOR_ACTION_SURFACES.has(action.surface)) return "action_surface_invalid";
  if (surface && action.surface !== surface) return "action_surface_mismatch";
  if (typeof action.type !== "string" || action.type.length === 0) return "action_type_invalid";
  if (typeof action.command !== "string" || action.command.length === 0) return "action_command_invalid";
  if (typeof action.why !== "string" || action.why.length === 0) return "action_why_invalid";
  for (const field of ["safe_to_auto_execute", "requires_approval", "destructive", "idempotent"]) {
    if (typeof action[field] !== "boolean") return `action_${field}_invalid`;
  }
  if (!action.spend_impact || action.spend_impact.currency !== "USD" || action.spend_impact.max_amount !== "0") {
    return "action_spend_impact_invalid";
  }
  if (action.surface === "shell") {
    if (!Array.isArray(action.argv) || action.argv.length === 0 || action.argv.some((part) => typeof part !== "string")) {
      return "action_argv_invalid";
    }
  } else {
    for (const field of BUZZ_DOCTOR_CONTRACT.next_action.non_shell_forbidden_fields) {
      if (field in action) return `action_${field}_forbidden`;
    }
  }
  return null;
}

export function validateBuzzDoctorReport(report, {
  expectedSubjectHex,
  walletProfile,
  nodeExecutable,
  run402Executable,
  relayOrigin,
  now = Date.now(),
} = {}) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return { valid: false, reason: "report_not_object" };
  if (report.contract_id !== BUZZ_DOCTOR_CONTRACT_ID || report.mode !== "buzz") return { valid: false, reason: "contract_mismatch" };
  if (!Array.isArray(report.checks)) return { valid: false, reason: "checks_not_array" };
  if (report.checks.length !== BUZZ_DOCTOR_CHECK_ORDER.length) return { valid: false, reason: "check_count_mismatch" };
  for (let index = 0; index < BUZZ_DOCTOR_CHECK_ORDER.length; index += 1) {
    const check = report.checks[index];
    const expectedName = BUZZ_DOCTOR_CHECK_ORDER[index];
    if (!check || check.name !== expectedName) return { valid: false, reason: "check_order_mismatch" };
    if (!BUZZ_DOCTOR_STATUSES.has(check.status)) return { valid: false, reason: "check_status_invalid" };
    if (check.status === "blocked" && !BUZZ_DOCTOR_CONTRACT.codes_by_check[expectedName]?.includes(check.code)) {
      return { valid: false, reason: "check_code_invalid" };
    }
    const actionable = check.status === "blocked" || (check.status === "warning" && Array.isArray(check.next_actions));
    if (actionable) {
      if (!Array.isArray(check.next_actions) || check.next_actions.length !== 1) return { valid: false, reason: "action_cardinality_invalid" };
      const actionReason = validateBuzzDoctorAction(check.next_actions[0]);
      if (actionReason) return { valid: false, reason: actionReason };
    } else if ("next_actions" in check) {
      return { valid: false, reason: "passing_action_forbidden" };
    }
  }
  const generatedAt = Date.parse(report.generated_at);
  if (!Number.isFinite(generatedAt) || generatedAt > now || now - generatedAt > BUZZ_DOCTOR_MAX_AGE_MS) {
    return { valid: false, reason: "report_stale" };
  }
  const binding = report.binding;
  if (!binding || typeof binding !== "object") return { valid: false, reason: "binding_missing" };
  const expected = {
    contract_id: BUZZ_DOCTOR_CONTRACT_ID,
    expected_subject_hex: expectedSubjectHex,
    wallet_profile: walletProfile,
    node_executable: nodeExecutable,
    run402_executable: run402Executable,
    relay_origin: relayOrigin,
  };
  for (const field of BUZZ_DOCTOR_CONTRACT.freshness.binding_fields) {
    if (expected[field] !== undefined && binding[field] !== expected[field]) return { valid: false, reason: `binding_${field}_mismatch` };
  }
  const computedOk = report.checks.every((check) => check.status !== "blocked");
  if (report.ok !== computedOk) return { valid: false, reason: "verdict_mismatch" };
  if (report.mutation_state !== BUZZ_DOCTOR_CONTRACT.zero_mutation.mutation_state) return { valid: false, reason: "mutation_state_invalid" };
  return { valid: true, reason: null };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
