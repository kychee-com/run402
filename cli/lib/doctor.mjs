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
import { GITVAULT_BYO_NO_PAYLOAD_COPY_STATEMENT } from "#sdk";
import { configDir, readAllowance, loadKeyStore } from "./config.mjs";
import { resolveGitvaultTarget } from "./gitvault-target.mjs";
import { getSdk } from "./sdk.mjs";
import {
  resolveScanRoot,
  scanSourceTree,
  SCAN_SEVERITY,
} from "./doctor-source-scan.mjs";
import { doctorUpdateCheck } from "./update-check.mjs";
import { buildBuzzDoctorReport, parseBuzzDoctorArgs } from "./buzz-doctor.mjs";
import { queueBuzzDoctorTelemetry } from "./diagnostic-telemetry.mjs";
import { fail } from "./sdk-errors.mjs";
import { normalizeArgv, assertKnownFlags, flagValue } from "./argparse.mjs";

/** Value-taking flags (kychee-com/run402#566 — the flag set doctor actually parses; anything else is BAD_USAGE via assertKnownFlags, never silently ignored). */
const DOCTOR_VALUE_FLAGS = ["--scan-dir", "--buzz-agent", "--project", "--only"];

/**
 * The stable, complete registry of ordinary-mode check names (kychee-com/run402#566,
 * the remaining half). One entry per `checks.push({ name: ... })` call below,
 * in the order each check normally runs. This is the ONE place `--only`
 * validates its argument against and the ONE place its help text is derived
 * from, so a check can never be selectable-but-undocumented or
 * documented-but-unselectable.
 *
 * Deliberately excludes buzz mode's own check names (`session_shell`,
 * `node_runtime`, …) — buzz mode is a wholly separate report shape that
 * returns before this array is ever consulted; see the `--only`/`--buzz`
 * mutual-exclusion check in `run()`.
 */
const DOCTOR_CHECK_NAMES = [
  "config_dir",
  "cli_update",
  "allowance",
  "projects",
  "api_reachable",
  "tier",
  "operator_health",
  "runtime_staleness",
  "recovery_posture",
  "gitvault",
  "source_scan",
];

/** Every value passed to a repeatable flag, in argv order (mirrors the pattern in buzz-notifications.mjs). */
function collectRepeatableFlag(args, flag) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    if (i + 1 >= args.length || (typeof args[i + 1] === "string" && args[i + 1].startsWith("--"))) {
      fail({ code: "BAD_FLAG", message: `${flag} requires a value`, details: { flag } });
    }
    values.push(args[i + 1]);
    i += 1;
  }
  return values;
}

const HELP = `run402 doctor — Health and config diagnostics

Usage:
  run402 doctor [--verbose] [--refresh] [--no-scan] [--scan-dir <D>] [--project <id>]
                [--only <check> ...]
  run402 --wallet <profile> doctor --buzz --buzz-agent <npub-or-hex>

Output:
  Stdout is a JSON report { ok, checks: [{ name, status, value?, hint?, message? }] }.
  Buzz mode adds { mode: "buzz", contract_id, generated_at, mutation_state,
  binding, telemetry } and uses check status ok|warning|blocked.

Options:
  --verbose      Include extra detail (timing, error messages)
  --refresh      Force a bounded live npm version check for the run402 CLI, even
                 if the cache is still within its 24h TTL. The cache self-heals
                 without this flag too: a MISSING or EXPIRED cache gets exactly
                 one bounded live attempt automatically on a plain \`doctor\` call.
                 A failed live check (offline) falls back to the last known-good
                 value, clearly labeled with its age — never a silent weeks-old
                 "latest" (kychee-com/run402#561). cli_update.value.cache always
                 reports fresh/age_ms/refresh_attempted/refresh_failed.
  --no-scan      Skip the source-tree scan (config / health checks only). Implied
                 by any --only that omits source_scan.
  --scan-dir D   Scan a custom directory instead of \`<cwd>/src\`
  --project <id> Target THIS project's gitvault check instead of the repo-standing
                 default (the 4.38.0 pin / run402 remote / RUN402_PROJECT_ID / active
                 project, in that order — see \`gitvault-target.mjs\`). Scoped to the
                 gitvault check only; every other check is wallet/machine-wide, not
                 per-project, and is unaffected by this flag. Composes with --only.
  --only <check> Run ONLY the named check (repeatable — pass it more than once
                 to run several). Every other check, INCLUDING the monorepo
                 source-tree scan, is suppressed rather than merely hidden: a
                 skipped check's network/filesystem work never runs at all, so
                 \`doctor --only gitvault\` costs one gitvault read, not a
                 config/tier/operator/scan sweep. An unknown check name is
                 BAD_USAGE listing the valid names below. Not used with --buzz
                 (buzz mode is its own separate, always-complete check set).
  --buzz         Run only the zero-mutation Buzz setup preflight
  --buzz-agent P Bind Buzz mode to the intended public agent npub or hex key

--only check names (ordinary mode; see "Checks performed" below for what each
one reports):
  ${DOCTOR_CHECK_NAMES.join(", ")}

Any flag not listed above is rejected (BAD_USAGE / UNKNOWN_FLAG), never
silently ignored.

Telemetry:
  Buzz preflight sends only anonymous allowlisted start/pass/block counters.
  No identity, wallet, relay, domain, path, command output, or installation id
  is sent. Set RUN402_TELEMETRY=0 to disable sending and local queueing.

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
  - Recovery posture: per vault-owning org, whether a human owner has a
    working control-plane login and whether any member holds a working
    source-access key (wrapper custody), plus a legacy-custody warning —
    the org's disaster backstops if the agent machine dies. Evidence
    levels: "configured" is what the platform verified, never proof an
    off-platform passkey or saved code still exists.
  - gitvault: the active project's vault — activation policy, whether THIS
    machine can produce the capture a 'required' policy demands, open
    unvaulted-override journals, and where the keystore lives (back it up:
    whole-keystore loss is terminal for vault history)
  - Source scan: hallucinated SDK auth names (R402_AUTH_UNKNOWN_EXPORT),
    state-changing GET handlers (R402_AUTH_STATE_CHANGING_GET),
    auth.* calls in prerendered pages (R402_AUTH_PRERENDERED),
    direct mutation of internal.sessions.authz_version
    (R402_AUTH_AUTHZ_VERSION_PROHIBITED).

Buzz mode checks (in order):
  session_shell, node_runtime, run402_cli, buzz_cli, buzz_agent_target,
  run402_api, run402_console, buzz_relay, wallet_profile.
  Buzz mode is read-only and skips the ordinary allowance, tier, project,
  operator, runtime-staleness, and source-tree checks.

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

/**
 * Compose a check-failure message context-first.
 *
 * The SDK kernel composes thrown messages as `<envelope message> while
 * <context>`, which reads as two jammed fragments when the envelope message
 * ends with a period ("…header. while checking tier status"). Strip the
 * SDK's trailing ` while <context>` segment (using the error's own
 * `context` field) and lead with the check label instead.
 */
function describeCheckFailure(label, err) {
  const raw = err instanceof Error ? err.message : String(err);
  const context = typeof err?.context === "string" && err.context.length > 0 ? err.context : null;
  let reason = raw;
  if (context) {
    const marker = ` while ${context}`;
    const idx = raw.indexOf(marker);
    if (idx !== -1) reason = (raw.slice(0, idx) + raw.slice(idx + marker.length)).trim();
  }
  return `${label} failed: ${reason}`;
}

export async function run(sub, args = []) {
  const all = normalizeArgv([sub, ...args].filter(Boolean));
  if (all.includes("--help") || all.includes("-h")) {
    console.log(HELP);
    return;
  }
  // kychee-com/run402#566 (--project half): doctor used to accept ANY flag
  // silently — an unrecognized one (a typo, or --project before this fix)
  // was simply never looked at. Any flag doctor actually parses is listed
  // here; anything else is now a structured BAD_USAGE/UNKNOWN_FLAG rejection
  // instead of quietly doing nothing.
  assertKnownFlags(all, ["--verbose", "--refresh", "--no-scan", "--buzz", ...DOCTOR_VALUE_FLAGS], DOCTOR_VALUE_FLAGS);
  const verbose = all.includes("--verbose");
  const refresh = all.includes("--refresh");
  const skipScan = all.includes("--no-scan");
  const scanDirArgIdx = all.indexOf("--scan-dir");
  const scanDirOverride = scanDirArgIdx >= 0 ? all[scanDirArgIdx + 1] : null;
  // Scoped to the gitvault check (see HELP): every other check is
  // wallet/machine-wide, not per-project.
  const projectOverride = flagValue(all, "--project");

  // kychee-com/run402#566 (the remaining half): --only <check>, repeatable.
  // Validated against the stable registry ABOVE the buzz early-return, so an
  // unknown name is BAD_USAGE regardless of which mode was also requested —
  // the same "every accepted flag must work or BAD_USAGE" bar #569 named for
  // doctor's own --human bug.
  const onlyChecks = collectRepeatableFlag(all, "--only");
  for (const name of onlyChecks) {
    if (!DOCTOR_CHECK_NAMES.includes(name)) {
      fail({
        code: "BAD_USAGE",
        message: `Unknown doctor check: '${name}'.`,
        hint: `Valid check names: ${DOCTOR_CHECK_NAMES.join(", ")}.`,
        details: { check: name, known_checks: DOCTOR_CHECK_NAMES },
      });
    }
  }
  // Buzz mode is a wholly separate, always-complete report shape — an --only
  // that named ordinary-mode checks would be silently ignored under --buzz,
  // exactly the class of bug #569 flagged for --human. Reject the
  // combination instead.
  if (onlyChecks.length > 0 && all.includes("--buzz")) {
    fail({
      code: "BAD_USAGE",
      message: "--only is not used with --buzz — buzz mode runs its own fixed, always-complete check set.",
      hint: "Drop --buzz to scope the ordinary check set with --only, or drop --only to run every buzz check.",
      details: { only: onlyChecks },
    });
  }
  const only = new Set(onlyChecks);
  /** `true` when `name` should run — every check when --only was not passed, otherwise exactly the named ones. */
  const wanted = (name) => only.size === 0 || only.has(name);

  const buzzArgs = parseBuzzDoctorArgs(all);
  if (buzzArgs.error) fail(buzzArgs.error);
  if (buzzArgs.buzz) {
    const startedAt = Date.now();
    const report = await buildBuzzDoctorReport({ expectedSubjectHex: buzzArgs.expectedSubjectHex });
    report.telemetry = queueBuzzDoctorTelemetry(report, { startedAt, finishedAt: Date.now() });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  const checks = [];
  const CONFIG_DIR = configDir();

  // 1. Config directory.
  if (wanted("config_dir")) try {
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
  if (wanted("cli_update")) try {
    checks.push(await doctorUpdateCheck({ refresh }));
  } catch (err) {
    checks.push({
      name: "cli_update",
      status: "unknown",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Allowance.
  let allowanceConfigured = false;
  if (wanted("allowance")) try {
    const allowance = readAllowance();
    if (allowance) {
      allowanceConfigured = true;
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
  if (wanted("projects")) try {
    const keystore = loadKeyStore();
    const projectCount = Object.keys(keystore?.projects ?? {}).length;
    checks.push({
      name: "projects",
      status: "ok",
      value: { project_count: projectCount },
      // State-aware parenthetical: only claim the wallet is set up when the
      // allowance check above actually passed; pre-init installs are pointed
      // at `run402 init` first.
      ...(projectCount === 0 && {
        hint: allowanceConfigured
          ? "No projects yet — run 'run402 projects provision' to create one (wallet is already set up)."
          : "No projects yet — run 'run402 init' to set up the wallet first, then 'run402 projects provision'.",
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
  if (wanted("api_reachable")) try {
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
  if (wanted("tier")) try {
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
      message: describeCheckFailure("tier status check", err),
    });
  }

  // 6. Operator health snapshot (v1.55 + v1.56 verification attempt detail).
  // The checks below all ride the SAME operator-status read (runtime_staleness
  // and recovery_posture reuse the response operator_health already pulled),
  // so the whole block is gated on wanting ANY — --only runtime_staleness
  // alone still needs this read, but --only-ing none skips it entirely, same
  // "don't do the work of a check nobody asked for" discipline the rest of
  // --only follows.
  if (wanted("operator_health") || wanted("runtime_staleness") || wanted("recovery_posture")) try {
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
    if (wanted("operator_health")) {
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
    }

    // 6b. Function runtime staleness (v1.69, capability
    // function-runtime-rebuild). A deployed function is stale when its Lambda
    // zip carries an older platform entry wrapper / bundled runtime than the
    // gateway's current build — a plain redeploy with unchanged source does
    // NOT refresh it (apply's release diff keys on the source code_hash, not
    // the wrapper). Read-only signal; refreshing is strictly opt-in. Reuses
    // the operator status fetched above to avoid a second round-trip.
    if (wanted("runtime_staleness")) {
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
    }

    // 6c. Org recovery posture (gitvault-recovery-custody). One entry per
    // vault-owning org the caller can see; rides the same operator-status
    // read. Evidence levels, not guarantees: "configured" names what the
    // platform VERIFIED — it can never observe whether an off-platform
    // passkey or saved code still exists. The two headline facts mirror the
    // feed events org_recovery_posture_degraded/_recovered; each gap line
    // carries its remedy (Anticipatory), same shape as the reachability gaps
    // above.
    if (wanted("recovery_posture")) {
      const posture = status.recovery_posture;
      if (!Array.isArray(posture)) {
        // Gateway older than gitvault-recovery-custody doesn't surface it.
        checks.push({
          name: "recovery_posture",
          status: "skipped",
          ...(verbose && { hint: "operator status has no 'recovery_posture' block; requires a gitvault-recovery-custody gateway." }),
        });
      } else if (posture.length === 0) {
        // No vault-owning org in the caller's view — nothing to lose, nothing to advise.
        checks.push({ name: "recovery_posture", status: "ok", value: { orgs: [] } });
      } else {
        const gaps = [];
        for (const org of posture) {
          const label = `org ${org.org_id} (${org.vault_count} vault${org.vault_count === 1 ? "" : "s"})`;
          if (org.control_plane_configured === false) {
            gaps.push(`${label}: no human owner with a working control-plane login — if this org's agent machine dies, nobody can sign in to recover it. Invite a backup human (run402 org invite create ${org.org_id} --email <their-email> --role owner) and have them complete login at console.run402.com.`);
          }
          if (org.source_backup_configured === false) {
            gaps.push(`${label}: no human member holds a working source-access key — vault history has no member-side decryption backup. Have a member complete source enrollment at console.run402.com/account → Source access.`);
          }
          if (org.custody_legacy_present === true) {
            gaps.push(`${label}: a member key is still on single-credential legacy custody (one passkey, no recovery code — losing that one credential loses source access). Re-enroll at console.run402.com/account to move to wrapper custody with a recovery code.`);
          }
        }
        checks.push(
          gaps.length > 0
            ? {
                name: "recovery_posture",
                status: "warning",
                value: { orgs: posture, gaps },
                hint: "These are the org's disaster-recovery backstops — the same facts arrive as org_recovery_posture_degraded/_recovered feed events. After enrolling, export the recovery bundle (run402 repos recovery-bundle) and store it separately from the code.",
              }
            : { name: "recovery_posture", status: "ok", value: { orgs: posture } },
        );
      }
    }
  } catch (err) {
    // Operator status endpoint may not be reachable if the operator-binding
    // substrate isn't deployed yet on the target API. Don't fail the whole
    // doctor over it — emit as a soft warning. The runtime-staleness check
    // rides on the same fetch, so skip it for the same reason.
    if (wanted("operator_health")) checks.push({
      name: "operator_health",
      status: "skipped",
      message: describeCheckFailure("operator status check", err),
      ...(verbose && { hint: "GET /agent/v1/operator/status not reachable; requires v1.55+ gateway." }),
    });
    if (wanted("runtime_staleness")) checks.push({
      name: "runtime_staleness",
      status: "skipped",
      message: describeCheckFailure("operator status check", err),
    });
    if (wanted("recovery_posture")) checks.push({
      name: "recovery_posture",
      status: "skipped",
      message: describeCheckFailure("operator status check", err),
    });
  }

  // 6c. gitvault (add-gitvault). Doctor was completely silent about the vault
  // even when `gitvault_policy: required` was the single thing that would break
  // the project's next deploy (dogfood #1, finding D1) — and doctor is where a
  // user looks when something is wrong. It also prints WHERE the keystore is:
  // "whole-keystore loss is terminal" was stated three times across this
  // surface while the directory to back up was stated nowhere (finding D2).
  //
  // Read-only and best-effort in every branch: no project, no vault, or a
  // gateway that does not know gitvault are all ordinary and report `skipped`
  // or `ok`, never a doctor failure. A vault-only project that has never
  // deployed is a first-class shape (protocol D183), so its mere absence of a
  // deploy raises nothing.
  //
  // TARGETING (repo-first-onramp follow-up, kychee-com/run402#559d, extended
  // by kychee-com/run402#566's --project half): when cwd is a repository
  // with its own pinned repo id or run402/origin remote, doctor checks THAT
  // vault, not the profile's active project — the same pin > remote >
  // RUN402_PROJECT_ID env > active-project order every other gitvault verb
  // follows (`gitvault-target.mjs`). An explicit `--project <id>` outranks
  // all of that (the resolver's own top tier), same as every other gitvault
  // verb's `--project`.
  if (wanted("gitvault")) {
    // gitvault-persistent-helper: a bounded LOCAL probe of the resident
    // helper engine — {running:false} is a fine answer, never a finding
    // (the daemon is an accelerator, not a dependency).
    const daemonInfo = await (async () => {
      try {
        const { daemonSocketPath } = await import("./daemon-path.mjs");
        const { connect: netConnect } = await import("node:net");
        return await new Promise((resolve) => {
          let settled = false;
          const done = (v) => {
            if (!settled) {
              settled = true;
              resolve(v);
            }
          };
          const socket = netConnect(daemonSocketPath());
          const timer = setTimeout(() => {
            socket.destroy();
            done({ running: false });
          }, 500);
          let data = "";
          socket.on("data", (c) => {
            data += c.toString("utf8");
            const nl = data.indexOf("\n");
            if (nl === -1) return;
            clearTimeout(timer);
            try {
              const { t: _t, ...rest } = JSON.parse(data.slice(0, nl));
              done({ running: true, ...rest });
            } catch {
              done({ running: false });
            }
            socket.end();
          });
          socket.once("error", () => {
            clearTimeout(timer);
            done({ running: false });
          });
          socket.once("connect", () => socket.write('{"t":"status"}\n'));
        });
      } catch {
        return { running: false };
      }
    })();
    const target = await resolveGitvaultTarget({ repoDir: process.cwd(), explicitProjectId: projectOverride ?? undefined });
    const projectId = target.project_id ?? null;
    const repoId = target.repo_id ?? null;
    if (!projectId && !repoId) {
      checks.push({
        name: "gitvault",
        status: "skipped",
        ...(verbose && { hint: "no active project — run 'run402 projects use <project_id>' to check its vault." }),
      });
    } else {
      try {
        const gv = await getSdk().gitvault.status({
          ...(repoId ? { repo_id: repoId } : { project_id: projectId }),
          repo_dir: process.cwd(),
        });
        const value = {
          project_id: gv.project_id ?? projectId,
          repo_id: gv.repo_id,
          vault: gv.vault === null ? null : "allocated",
          // gitvault-byo-primary-bucket task 3.5 — absent-or-"managed" is
          // byte-identical to before this fold for every non-BYO vault.
          storage_profile: gv.vault?.storage_profile ?? null,
          byo_destination: gv.vault?.byo_destination ?? null,
          gitvault_policy: gv.gitvault_policy,
          keystore_root: gv.keystore.root,
          can_sign: gv.keystore.can_sign,
          holds_repo_key: gv.keystore.holds_repo_key,
          pending_overrides: gv.pending_overrides,
          pins: gv.pins,
          remote: gv.remote,
          // dogfood item 2: `null` (unknown) or <= 1 means the single-principal
          // V0-A terminal-loss statement below is honest; >= 2 means the SDK
          // already proved a second covering recipient, so the hint switches
          // to the durability sentence instead of the terminal-loss claim.
          covering_recipients: gv.covering_recipients ?? null,
          daemon: daemonInfo,
          // gitvault-multi-writer (rev 47) task 6.2 — this machine's own
          // standing on the vault's chain-verified writer set. `null` only
          // when there is no vault at all (nothing to be a writer OF).
          // `read_only_vault` takes priority over the caller's own standing
          // — the D228 terminal state blocks EVERY push regardless of who
          // is asking.
          writer: gv.vault === null
            ? null
            : gv.vault.read_only_terminal
              ? "read_only_vault"
              : gv.vault.writer_set?.writers.some((w) => w.writer_key_id === gv.keystore.identity_fingerprint)
                ? "active"
                : gv.vault.pending_writers?.some((p) => p.writer_key_id === gv.keystore.identity_fingerprint)
                  ? "pending"
                  : "not_admitted",
        };
        const gaps = [];
        if (value.writer === "read_only_vault") {
          gaps.push("this vault has lost its last writer (D228 read-only terminal) — it still serves reads, but no push can be admitted until a new writer is admitted through a recovery path");
        } else if (value.writer === "pending") {
          gaps.push("this machine's key is an eligible writer candidate but not yet admitted — run 'run402 repos access sync' if you already hold writer standing on this vault, or ask a current writer to run any gitvault operation");
        } else if (value.writer === "not_admitted") {
          gaps.push("this machine's key is not an active writer on this vault — a push from here is refused GITVAULT_WRITER_NOT_ADMITTED; ask a current writer to admit you (org membership at role developer+ and a published signing key make you eligible)");
        }
        // The one that actually breaks the next deploy: the project demands a
        // vaulted capture and THIS machine cannot produce one.
        if (gv.gitvault_policy === "required" && !gv.keystore.holds_repo_key) {
          gaps.push(
            "gitvault_policy is 'required' but this machine holds no key for the vault — a deploy from here is refused with GITVAULT_CLIENT_UPGRADE_REQUIRED. " +
            "Run 'run402 repos create --project <id>' (idempotent; resolves to the existing repo), or 'run402 repos policy grandfathered --reason <why>' to un-gate the project.",
          );
        } else if (gv.gitvault_policy === "required" && !gv.keystore.can_sign) {
          gaps.push("gitvault_policy is 'required' and this keystore is read-only (no signing key) — it can verify but cannot publish the capture a deploy needs");
        }
        if (gv.pending_overrides > 0) {
          gaps.push(`${gv.pending_overrides} unvaulted-override journal(s) are still open — run 'run402 repos snapshot' to drain them`);
        }
        // `matches` is a TRI-STATE (kychee-com/run402#562): `false` alone is
        // a real mismatch. `null` (a slug-form remote not yet resolved on
        // this machine) is not evidence of anything wrong — `!gv.remote.matches`
        // used to treat null the same as false and would have warned here.
        if (gv.remote && gv.remote.matches === false) {
          gaps.push(`the '${gv.remote.name}' git remote points at a different project than ${value.project_id} (${gv.remote.url})`);
        }
        // kygit-handoff design D8: the mirror of the OLD `npm i -g @kychee/kygit`
        // bug, pointing the other way — a `kygit::` remote with no
        // `git-remote-kygit` helper on PATH means every push/clone/fetch
        // in this checkout fails inside git with an opaque error.
        if (gv.remote?.url?.startsWith("kygit::")) {
          const { isExecutableOnPath } = await import("./path-lookup.mjs");
          if (!isExecutableOnPath("git-remote-kygit")) {
            gaps.push("this checkout's remote is kygit:: but git-remote-kygit is not on PATH — run `npm i -g @kychee/kygit`");
          }
        }
        // Echoed exactly as the SDK reported them — including the
        // doctor-persistent `grandfathered` advisory it owns.
        for (const w of gv.warnings ?? []) gaps.push(`${w.kind}: ${w.message}`);

        // gitvault-mirror-and-recover task 4.3 + gitvault-mirror-default:
        // mirror currency, reported ALONGSIDE (never in place of) the
        // deploy-related gaps above, and never blocking `run402 deploy`'s
        // own gate — the vault lane's outcome is unaffected regardless of
        // mirror state (design D6). `mirror_currency` mirrors `mirror
        // status`'s own tri-state: `current` / `stale` / `unknown` (mirror
        // unreachable or vault unread). Only STALE is actionable enough to
        // become a warning gap; a vault with no successful mirror copy yet
        // carries the SDK-computed `vault_unmirrored` finding — named and
        // standing (gitvault-mirror-default supersedes the old anonymous
        // `advisory` string), echoed verbatim, and deliberately NOT pushed
        // into `gaps`: informational, never blocking, computed client-side
        // only, cleared by the first successful mirror write or sync.
        if (gv.vault !== null && value.repo_id) {
          try {
            const mirrorStatus = await getSdk().gitvault.mirrorStatus({ repo_id: value.repo_id, is_byo: value.storage_profile === "byo" });
            value.gitvault_mirror = {
              configured: mirrorStatus.configured,
              destination: mirrorStatus.destination,
              mirrored_generation: mirrorStatus.mirrored_generation,
              newest_generation: mirrorStatus.newest_generation,
              is_current: mirrorStatus.is_current,
              last_success_at: mirrorStatus.last_success_at,
              finding: mirrorStatus.finding,
              validity_not_freshness: mirrorStatus.validity_not_freshness,
              keystore_still_required: mirrorStatus.keystore_still_required,
            };
            if (mirrorStatus.is_current === false) {
              gaps.push(`the ciphertext mirror at ${mirrorStatus.destination} is STALE (mirrored generation ${mirrorStatus.mirrored_generation ?? "(none)"}, vault newest ${mirrorStatus.newest_generation ?? "(none)"}) — ${mirrorStatus.closing_command}`);
            }
          } catch {
            // Best-effort: a mirror status read failing is never a doctor
            // failure, and never touches the deploy-related gaps above.
          }
        }

        // gitvault-byo-primary-bucket task 3.5 — unconditional, independent
        // of mirror status (D7); imported from the canonical constants, never
        // paraphrased.
        const byoDisclosure = value.storage_profile === "byo" ? ` Storage: byo (${value.byo_destination ?? "(unknown)"}) — ${GITVAULT_BYO_NO_PAYLOAD_COPY_STATEMENT}` : "";
        checks.push({
          name: "gitvault",
          status: gaps.length > 0 ? "warning" : "ok",
          value: gaps.length > 0 ? { ...value, gaps } : value,
          hint: (gv.vault === null
            ? `No vault for this project (that is a normal shape). Allocate one with 'run402 repos create --project <id>'. Keystore: ${gv.keystore.root}`
            : gv.durability_statement
              ? `Back up ${gv.keystore.root} anyway — ${gv.durability_statement} (covering_recipients: ${gv.covering_recipients})`
              : `Back up ${gv.keystore.root} — whole-machine or whole-keystore loss is terminal for vault history.`) + byoDisclosure,
        });
      } catch (err) {
        // A gateway without gitvault, an unreachable API, or a project this
        // wallet cannot see. None of those is a local health problem.
        checks.push({
          name: "gitvault",
          status: "skipped",
          message: describeCheckFailure("gitvault status check", err),
        });
      }
    }
  }

  // 7. Source-tree scan (auth-aware-ssr Section 9). Detects hallucinated
  // SDK names, state-changing GETs, auth.* in prerendered pages, and
  // direct mutation of internal.sessions.authz_version. Hits with severity
  // `error` block deploy (`run402 deploy` wraps doctor and respects exit
  // code). Skipped via --no-scan when the user wants config-only checks, and
  // by any --only that omits it (kychee-com/run402#566 — this is the check
  // that used to bury the gitvault diagnosis under ~1,800 monorepo findings).
  if (!skipScan && wanted("source_scan")) {
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
