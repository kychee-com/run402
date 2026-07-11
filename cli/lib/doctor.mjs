/**
 * run402 doctor — Health and config diagnostics.
 *
 * Reports the state of the local Run402 setup: config dir, allowance,
 * tier, project selection, API reachability. Agent-friendly: with
 * `--json`, emits a structured report the agent can branch on without
 * parsing English output.
 *
 * Capability `astro-ssr-runtime` (Run402 v1.52). Part of the agent-DX
 * contract — agents run `run402 doctor` first to verify the environment
 * before attempting other commands.
 */

import { existsSync, statSync } from "node:fs";
import { configDir, readAllowance, loadKeyStore } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import {
  resolveScanRoot,
  scanSourceTree,
  SCAN_SEVERITY,
} from "./doctor-source-scan.mjs";
import { doctorUpdateCheck } from "./update-check.mjs";

const HELP = `run402 doctor — Health and config diagnostics

Usage:
  run402 doctor [--verbose] [--refresh] [--no-scan] [--scan-dir <D>]

Output:
  Stdout is a JSON report { ok, checks: [{ name, status, value?, hint?, message? }] }.

Options:
  --verbose      Include extra detail (timing, error messages)
  --refresh      Wait for a bounded live npm version check for the run402 CLI
  --no-scan      Skip the source-tree scan (config / health checks only)
  --scan-dir D   Scan a custom directory instead of \`<cwd>/src\`

Checks performed:
  - Config directory exists and is writable
  - Installed run402 CLI version and update guidance
  - Allowance is configured and on a valid rail (x402 / mpp)
  - Keystore has at least one wallet
  - API_BASE is reachable (network check via /health)
  - Active tier resolves and is not 'past_due' / 'frozen'
  - Function runtime staleness: deployed functions running an older platform
    runtime than the current gateway build (refresh with 'run402 functions
    rebuild --all'; re-bundles from your stored source, no source change)
  - Source scan: hallucinated SDK auth names (R402_AUTH_UNKNOWN_EXPORT),
    state-changing GET handlers (R402_AUTH_STATE_CHANGING_GET),
    auth.* calls in prerendered pages (R402_AUTH_PRERENDERED),
    direct mutation of internal.sessions.authz_version
    (R402_AUTH_AUTHZ_VERSION_PROHIBITED).

Exit codes:
  0  — all checks pass
  1  — one or more checks failed (details in output)
`;

function redactAllowanceForDiagnostics(allowance) {
  if (!allowance || typeof allowance !== "object") return allowance;
  const safe = { ...allowance };
  delete safe.privateKey;
  return safe;
}

export async function run(sub, args = []) {
  const all = [sub, ...args].filter(Boolean);
  if (all.includes("--help") || all.includes("-h")) {
    console.log(HELP);
    return;
  }
  const verbose = all.includes("--verbose");
  const refresh = all.includes("--refresh");
  const skipScan = all.includes("--no-scan");
  const scanDirArgIdx = all.indexOf("--scan-dir");
  const scanDirOverride = scanDirArgIdx >= 0 ? all[scanDirArgIdx + 1] : null;

  const checks = [];
  const CONFIG_DIR = configDir();

  // 1. Config directory.
  try {
    if (existsSync(CONFIG_DIR) && statSync(CONFIG_DIR).isDirectory()) {
      checks.push({ name: "config_dir", status: "ok", value: CONFIG_DIR });
    } else {
      checks.push({
        name: "config_dir",
        status: "missing",
        value: CONFIG_DIR,
        hint: "Run 'run402 init' to set up the config directory.",
      });
    }
  } catch (err) {
    checks.push({
      name: "config_dir",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 1b. CLI version/update state. This is advisory: stale or unknown version
  // state should help the user, not hide the rest of doctor.
  try {
    checks.push(await doctorUpdateCheck({ refresh }));
  } catch (err) {
    checks.push({
      name: "cli_update",
      status: "unknown",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Allowance.
  try {
    const allowance = readAllowance();
    if (allowance) {
      checks.push({
        name: "allowance",
        status: "ok",
        value: {
          rail: allowance.rail,
          // Don't surface amounts or addresses unless --verbose; agents
          // checking for config presence don't need wallet details. Never
          // include keystore secrets in diagnostics, even in verbose mode.
          ...(verbose && { details: redactAllowanceForDiagnostics(allowance) }),
        },
      });
    } else {
      checks.push({
        name: "allowance",
        status: "missing",
        hint: "Run 'run402 init' to create an allowance.",
      });
    }
  } catch (err) {
    checks.push({
      name: "allowance",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Project keystore. The wallet itself lives in allowance.json (verified
  // by check 2 above); this checks the per-project keys (anon_key /
  // service_key) that `run402 projects provision` writes. An empty store is
  // normal for fresh installs that haven't provisioned a project yet, so
  // report informationally as `ok` rather than warning.
  try {
    const keystore = loadKeyStore();
    const projectCount = Object.keys(keystore?.projects ?? {}).length;
    checks.push({
      name: "projects",
      status: "ok",
      value: { project_count: projectCount },
      ...(projectCount === 0 && {
        hint: "No projects yet — run 'run402 projects provision' to create one (wallet is already set up).",
      }),
    });
  } catch (err) {
    checks.push({
      name: "projects",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 4. API base reachability.
  try {
    const sdk = getSdk();
    // Use the service.status endpoint (read-only, unauthenticated).
    const t0 = Date.now();
    await sdk.service.status();
    const elapsed = Date.now() - t0;
    checks.push({
      name: "api_reachable",
      status: "ok",
      ...(verbose && { value: { elapsed_ms: elapsed } }),
    });
  } catch (err) {
    checks.push({
      name: "api_reachable",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
      hint: "Check the RUN402_API_BASE env var and your network connection.",
    });
  }

  // 5. Active tier.
  try {
    const sdk = getSdk();
    const tier = await sdk.tier.status();
    const tierName = tier?.tier ?? null;
    const lifecycle = tier?.organization_lifecycle_state ?? null;
    const active = tier?.active === true;
    if (tierName && active && lifecycle === "active") {
      checks.push({
        name: "tier",
        status: "ok",
        value: { tier: tierName, active, organization_lifecycle_state: lifecycle },
      });
    } else {
      const status = lifecycle && lifecycle !== "active"
        ? lifecycle
        : tierName && !active
          ? "inactive"
          : tierName && lifecycle === null
            ? "unknown"
            : tierName ?? "missing";
      checks.push({
        name: "tier",
        status,
        value: {
          tier: tierName,
          active,
          organization_lifecycle_state: lifecycle,
          lease_expires_at: tier?.lease_expires_at ?? null,
        },
        hint: lifecycle === null && tierName
          ? "Tier resolved, but organization lifecycle could not be determined. Check `run402 tier status` before assuming the account is healthy."
          : "Run 'run402 tier set prototype' to subscribe, renew, or reactivate the tier.",
      });
    }
  } catch (err) {
    checks.push({
      name: "tier",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 6. Operator health snapshot (v1.55 + v1.56 verification attempt detail).
  try {
    const sdk = getSdk();
    const status = await sdk.admin.getOperatorStatus();
    const gaps = [];
    if (status.operator_contact.email_status !== "verified") {
      // v1.56: prefer the structured email_verification.last_challenge.hint
      // over the generic "email not verified" message. The gateway computes
      // a per-reason remediation hint that's actionable for the operator.
      const ev = status.email_verification;
      const ch = ev?.last_challenge;
      if (ch && ch.hint) {
        const attemptsLine = ch.attempt_count > 0
          ? ` (${ch.attempt_count}/${ch.attempt_count + ch.remaining_attempts} attempts used, ${ch.remaining_attempts} remaining)`
          : "";
        gaps.push(`operator email not verified${attemptsLine}: ${ch.hint}`);
      } else {
        gaps.push(`operator email not verified (${status.operator_contact.email_status}) — run 'run402 agent contact --email ...' then reply to the challenge`);
      }
    }
    if (status.operator_contact.passkey_status !== "verified") {
      gaps.push("operator passkey not bound — run 'run402 agent passkey enroll' after email verification");
    }
    // recovery-event-reachability: org-level reachability of mandatory
    // (recovery/security) notifications. Distinct from the per-wallet contact
    // check above — an org can be reachable via a member's verified email
    // even when this wallet has no contact, and vice versa. Omitted by older
    // gateways.
    const reach = status.operator_reachability;
    if (reach && reach.reachable === false) {
      const skipped = reach.skipped_last_90d > 0
        ? ` (${reach.skipped_last_90d} notification(s) already skipped in the last 90 days)`
        : "";
      gaps.push(`no verified notification recipient — mandatory recovery/security notifications currently reach nobody${skipped}; run 'run402 agent contact --email ...' then reply to the challenge`);
    }
    if (Array.isArray(status.skipped_notifications) && status.skipped_notifications.length > 0) {
      gaps.push(`${status.skipped_notifications.length} notification(s) skipped due to missing verified recipient`);
    }
    if (Array.isArray(status.critical_items) && status.critical_items.length > 0) {
      for (const item of status.critical_items) {
        gaps.push(`${item.kind}: ${item.detail}`);
      }
    }
    if (gaps.length > 0) {
      checks.push({
        name: "operator_health",
        status: "warning",
        value: { gaps },
        hint: "Address the above gaps; they're what 'run402 notifications' is designed to surface.",
      });
    } else {
      checks.push({ name: "operator_health", status: "ok" });
    }

    // 6b. Function runtime staleness (v1.69, capability
    // function-runtime-rebuild). A deployed function is stale when its Lambda
    // zip carries an older platform entry wrapper / bundled runtime than the
    // gateway's current build — a plain redeploy with unchanged source does
    // NOT refresh it (apply's release diff keys on the source code_hash, not
    // the wrapper). Read-only signal; refreshing is strictly opt-in. Reuses
    // the operator status fetched above to avoid a second round-trip.
    const runtime = status.runtime;
    if (runtime && typeof runtime.stale_function_count === "number") {
      if (runtime.stale_function_count > 0) {
        checks.push({
          name: "runtime_staleness",
          status: "warning",
          value: {
            stale_function_count: runtime.stale_function_count,
            stale_functions: runtime.stale_functions ?? [],
          },
          hint: `${runtime.stale_function_count} function(s) are running an older platform runtime. Run 'run402 functions rebuild --all' to refresh (re-bundles from your stored source; no source change).`,
        });
      } else {
        checks.push({
          name: "runtime_staleness",
          status: "ok",
          value: { stale_function_count: 0 },
        });
      }
    } else {
      // Gateway older than v1.69 doesn't surface the runtime block.
      checks.push({
        name: "runtime_staleness",
        status: "skipped",
        ...(verbose && { hint: "operator status has no 'runtime' block; requires v1.69+ gateway." }),
      });
    }
  } catch (err) {
    // Operator status endpoint may not be reachable if the operator-binding
    // substrate isn't deployed yet on the target API. Don't fail the whole
    // doctor over it — emit as a soft warning. The runtime-staleness check
    // rides on the same fetch, so skip it for the same reason.
    checks.push({
      name: "operator_health",
      status: "skipped",
      message: err instanceof Error ? err.message : String(err),
      ...(verbose && { hint: "GET /agent/v1/operator/status not reachable; requires v1.55+ gateway." }),
    });
    checks.push({
      name: "runtime_staleness",
      status: "skipped",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 7. Source-tree scan (auth-aware-ssr Section 9). Detects hallucinated
  // SDK names, state-changing GETs, auth.* in prerendered pages, and
  // direct mutation of internal.sessions.authz_version. Hits with severity
  // `error` block deploy (`run402 deploy` wraps doctor and respects exit
  // code). Skipped via --no-scan when the user wants config-only checks.
  if (!skipScan) {
    try {
      const scanRoot = scanDirOverride ?? resolveScanRoot(process.cwd());
      const findings = scanSourceTree(scanRoot, { cwd: process.cwd() });
      const errorFindings = findings.filter((f) => f.severity === SCAN_SEVERITY.ERROR);
      const warnFindings = findings.filter((f) => f.severity === SCAN_SEVERITY.WARN);
      if (findings.length === 0) {
        checks.push({ name: "source_scan", status: "ok", value: { scan_root: scanRoot, file_count_with_findings: 0 } });
      } else {
        checks.push({
          name: "source_scan",
          status: errorFindings.length > 0 ? "error" : "warning",
          value: {
            scan_root: scanRoot,
            findings: errorFindings.length + warnFindings.length,
            errors: errorFindings.length,
            warnings: warnFindings.length,
            details: findings,
          },
          hint: errorFindings.length > 0
            ? "Fix the R402_AUTH_* findings above. `run402 deploy` will refuse to ship until these are resolved."
            : "Source scan emitted warnings (non-blocking). Review and address when convenient.",
        });
      }
    } catch (err) {
      checks.push({
        name: "source_scan",
        status: "skipped",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 'warning' counts as ok for exit-code purposes — gaps are surfaced in
  // output but don't fail the doctor. Only hard 'error' / 'missing' /
  // 'empty' fail.
  const allOk = checks.every((c) => c.status === "ok" || c.status === "warning" || c.status === "skipped" || c.status === "unknown");

  console.log(JSON.stringify({ ok: allOk, checks }, null, 2));
  process.exit(allOk ? 0 : 1);
}
