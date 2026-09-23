/**
 * The frozen Buzz setup preflight contract (`run402.buzz-doctor.v1`) and the
 * released Buzz CLI v0.5.2 capability fixture `r.buzz.doctor()` probes
 * against. The objects below are the published fixtures verbatim
 * (`buzz/fixtures/run402-buzz-doctor-v1-contract.json` and
 * `buzz/fixtures/buzz-v0.5.2-cli-capabilities.json`, shipped with the
 * `run402-buzz` skill); `buzz-doctor-contract.test.ts` fails when they drift.
 * The validators are what a consumer of a doctor report (the Buzz setup
 * helper) applies before trusting it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

/** `run402-buzz-doctor-v1-contract.json`, verbatim. */
export const BUZZ_DOCTOR_CONTRACT = deepFreeze({
  "schema_version": 1,
  "contract_id": "run402.buzz-doctor.v1",
  "mode": "buzz",
  "canonical_invocation": [
    "run402",
    "--wallet",
    "<profile>",
    "doctor",
    "--buzz",
    "--buzz-agent",
    "<npub-or-hex>"
  ],
  "flags": {
    "mode": "--buzz",
    "agent": "--buzz-agent",
    "profile": "--wallet"
  },
  "check_order": [
    "session_shell",
    "node_runtime",
    "run402_cli",
    "buzz_cli",
    "buzz_agent_target",
    "run402_api",
    "run402_console",
    "buzz_relay",
    "wallet_profile"
  ],
  "statuses": [
    "ok",
    "warning",
    "blocked"
  ],
  "codes_by_check": {
    "session_shell": [
      "BUZZ_PREFLIGHT_SHELL_UNAVAILABLE"
    ],
    "node_runtime": [
      "BUZZ_PREFLIGHT_NODE_UNAVAILABLE",
      "BUZZ_PREFLIGHT_NODE_INCOMPATIBLE"
    ],
    "run402_cli": [
      "BUZZ_PREFLIGHT_RUN402_UNAVAILABLE",
      "BUZZ_PREFLIGHT_RUN402_INCOMPATIBLE",
      "BUZZ_PREFLIGHT_RUN402_UPDATE_AVAILABLE"
    ],
    "buzz_cli": [
      "BUZZ_PREFLIGHT_BUZZ_CLI_UNAVAILABLE",
      "BUZZ_PREFLIGHT_BUZZ_CLI_INCOMPATIBLE"
    ],
    "buzz_agent_target": [
      "BUZZ_AGENT_TARGET_REQUIRED",
      "BUZZ_AGENT_TARGET_UNVERIFIED",
      "BUZZ_AGENT_TARGET_MISMATCH"
    ],
    "run402_api": [
      "BUZZ_PREFLIGHT_API_UNREACHABLE"
    ],
    "run402_console": [
      "BUZZ_PREFLIGHT_CONSOLE_UNREACHABLE"
    ],
    "buzz_relay": [
      "BUZZ_PREFLIGHT_RELAY_UNSAFE",
      "BUZZ_PREFLIGHT_RELAY_UNREACHABLE"
    ],
    "wallet_profile": [
      "BUZZ_PREFLIGHT_WALLET_PROFILE_REQUIRED",
      "BUZZ_PREFLIGHT_WALLET_PROFILE_NOT_FOUND",
      "BUZZ_PREFLIGHT_WALLET_PROFILE_MISMATCH"
    ]
  },
  "next_action": {
    "required_fields": [
      "type",
      "surface",
      "command",
      "why",
      "safe_to_auto_execute",
      "requires_approval",
      "destructive",
      "idempotent",
      "spend_impact"
    ],
    "surfaces": [
      "shell",
      "buzz_chat",
      "buzz_settings"
    ],
    "shell_required_fields": [
      "argv"
    ],
    "non_shell_forbidden_fields": [
      "argv",
      "cwd"
    ],
    "cardinality_per_actionable_check": 1
  },
  "exit_behavior": {
    "passed_or_warning_only": 0,
    "completed_with_blocked_checks": 1,
    "usage_error": 1,
    "completed_report_stream": "stdout",
    "usage_error_stream": "stderr"
  },
  "freshness": {
    "max_age_seconds": 60,
    "binding_fields": [
      "contract_id",
      "expected_subject_hex",
      "wallet_profile",
      "node_executable",
      "run402_executable",
      "relay_origin"
    ]
  },
  "setup_rejection_codes": [
    "BUZZ_PREFLIGHT_REPORT_INVALID",
    "BUZZ_PREFLIGHT_REPORT_STALE",
    "BUZZ_PREFLIGHT_REPORT_MISMATCH"
  ],
  "zero_mutation": {
    "mutation_state": "not_started",
    "forbidden": [
      "buzz_event_publish",
      "buzz_arbitrary_sign",
      "run402_profile_create_or_select",
      "run402_wallet_create",
      "run402_identity_link_mutation",
      "run402_faucet",
      "run402_tier_mutation",
      "run402_project_mutation",
      "run402_deploy"
    ],
    "allowed_lossy_local_writes": [
      "cli_update_cache",
      "redacted_diagnostic_queue"
    ]
  }
} as const);

/** `buzz-v0.5.2-cli-capabilities.json`, verbatim. */
export const BUZZ_CLI_CAPABILITIES = deepFreeze({
  "fixture_version": 1,
  "fixture_id": "buzz-cli-v0.5.2-capabilities",
  "purpose": "released_buzz_cli_capability_first_compatibility",
  "buzz_release": {
    "version": "0.5.2",
    "release_tag": "v0.5.2",
    "release_tag_commit": "3e48f1b2365d326ee1c9582448d86a99b44ecd5d",
    "run402_change_required": false
  },
  "help_probes": [
    {
      "argv": [
        "buzz",
        "--help"
      ],
      "exit_code": 0,
      "stdout_contains": [
        "Buzz CLI \u2014 interact with a Buzz relay",
        "users",
        "social",
        "Errors are JSON on stderr"
      ]
    },
    {
      "argv": [
        "buzz",
        "users",
        "get",
        "--help"
      ],
      "exit_code": 0,
      "stdout_contains": [
        "users get [OPTIONS]",
        "--pubkey",
        "Omit for your own profile"
      ]
    },
    {
      "argv": [
        "buzz",
        "social",
        "publish",
        "--help"
      ],
      "exit_code": 0,
      "stdout_contains": [
        "social publish [OPTIONS]",
        "--content"
      ]
    },
    {
      "argv": [
        "buzz",
        "social",
        "event",
        "--help"
      ],
      "exit_code": 0,
      "stdout_contains": [
        "social event --event"
      ]
    }
  ],
  "version_probe": {
    "argv": [
      "buzz",
      "--version"
    ],
    "supported": false,
    "exit_code": 1,
    "stderr_json": {
      "error": "user_error",
      "retryable": false
    },
    "message_contains": "unexpected argument '--version'"
  },
  "json_contract": {
    "default_output_format": "json",
    "users_get_success_stdout": {
      "type": "array",
      "empty_array_means": "public_self_profile_unverified",
      "profile_pubkey_field": "pubkey"
    },
    "social_event_success_stdout": {
      "type": "array",
      "event_pubkey_field": "pubkey"
    },
    "error_stderr": {
      "type": "object",
      "required_fields": [
        "error",
        "message",
        "retryable"
      ],
      "stdout_is_empty": true
    }
  },
  "managed_sidecar": {
    "distribution": "bundled_with_buzz_desktop",
    "session_discovery": "managed_agent_path",
    "public_package_manager_install": false,
    "repair_surface": "buzz_settings",
    "repair_destination": "Buzz Desktop > Settings > Updates",
    "repair_instruction": "Open Buzz Desktop > Settings > Updates, install the available Buzz update or reinstall Buzz Desktop if no update is offered, then restart this agent and rerun setup."
  },
  "public_self_observation": {
    "argv": [
      "buzz",
      "users",
      "get"
    ],
    "requires_private_key_value_inspection": false,
    "empty_or_malformed_result": "BUZZ_AGENT_TARGET_UNVERIFIED"
  },
  "write_surface_policy": {
    "capability_probes_use_help_only": true,
    "publish_is_never_invoked_by_doctor": true,
    "event_read_requires_explicit_event_id_and_is_not_used_for_self_discovery": true
  }
} as const);

export const BUZZ_DOCTOR_CONTRACT_ID: string = BUZZ_DOCTOR_CONTRACT.contract_id;
export const BUZZ_DOCTOR_CHECK_ORDER: readonly string[] = BUZZ_DOCTOR_CONTRACT.check_order;
export const BUZZ_DOCTOR_STATUSES: ReadonlySet<string> = new Set(BUZZ_DOCTOR_CONTRACT.statuses);
export const BUZZ_DOCTOR_ACTION_SURFACES: ReadonlySet<string> = new Set(BUZZ_DOCTOR_CONTRACT.next_action.surfaces);
export const BUZZ_DOCTOR_MAX_AGE_MS: number = BUZZ_DOCTOR_CONTRACT.freshness.max_age_seconds * 1000;

/** The reason an action violates the contract, or null. */
export function validateBuzzDoctorAction(action: any, { surface }: { surface?: string } = {}): string | null {
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
    if (!Array.isArray(action.argv) || action.argv.length === 0 || action.argv.some((part: unknown) => typeof part !== "string")) {
      return "action_argv_invalid";
    }
  } else {
    for (const field of BUZZ_DOCTOR_CONTRACT.next_action.non_shell_forbidden_fields) {
      if (field in action) return `action_${field}_forbidden`;
    }
  }
  return null;
}

/** Whether a report honours the contract and is bound to the expected session, fresh. */
export function validateBuzzDoctorReport(report: any, {
  expectedSubjectHex,
  walletProfile,
  nodeExecutable,
  run402Executable,
  relayOrigin,
  now = Date.now(),
}: {
  expectedSubjectHex?: string | null;
  walletProfile?: string;
  nodeExecutable?: string | null;
  run402Executable?: string | null;
  relayOrigin?: string | null;
  now?: number;
} = {}): { valid: boolean; reason: string | null } {
  if (!report || typeof report !== "object" || Array.isArray(report)) return { valid: false, reason: "report_not_object" };
  if (report.contract_id !== BUZZ_DOCTOR_CONTRACT_ID || report.mode !== "buzz") return { valid: false, reason: "contract_mismatch" };
  if (!Array.isArray(report.checks)) return { valid: false, reason: "checks_not_array" };
  if (report.checks.length !== BUZZ_DOCTOR_CHECK_ORDER.length) return { valid: false, reason: "check_count_mismatch" };
  for (let index = 0; index < BUZZ_DOCTOR_CHECK_ORDER.length; index += 1) {
    const check = report.checks[index];
    const expectedName = BUZZ_DOCTOR_CHECK_ORDER[index]!;
    if (!check || check.name !== expectedName) return { valid: false, reason: "check_order_mismatch" };
    if (!BUZZ_DOCTOR_STATUSES.has(check.status)) return { valid: false, reason: "check_status_invalid" };
    const codes = (BUZZ_DOCTOR_CONTRACT.codes_by_check as Record<string, readonly string[]>)[expectedName];
    if (check.status === "blocked" && !codes?.includes(check.code)) {
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
  const expected: Record<string, unknown> = {
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
  const computedOk = report.checks.every((check: { status: string }) => check.status !== "blocked");
  if (report.ok !== computedOk) return { valid: false, reason: "verdict_mismatch" };
  if (report.mutation_state !== BUZZ_DOCTOR_CONTRACT.zero_mutation.mutation_state) return { valid: false, reason: "mutation_state_invalid" };
  return { valid: true, reason: null };
}
