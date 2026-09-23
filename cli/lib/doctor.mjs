/**
 * run402 doctor — health and config diagnostics: the CLI edge of `r.doctor()`
 * (`@run402/sdk/node`), which owns every ordinary-mode check and the
 * `{ ok, blocking[], warnings[], checks[] }` fold. This module parses argv,
 * supplies what only the CLI knows — its own update check and its resident
 * vault helper — prints the report, and exits 0 exactly when `ok`.
 * `--buzz` runs the Buzz setup preflight instead (`buzz-doctor.mjs`).
 */

import { DOCTOR_CHECK_NAMES, assertDoctorCheckNames } from "#sdk/node";
import { getSdk } from "./sdk.mjs";
import { doctorUpdateCheck } from "./update-check.mjs";
import { buildBuzzDoctorReport, parseBuzzDoctorArgs } from "./buzz-doctor.mjs";
import { queueBuzzDoctorTelemetry } from "./diagnostic-telemetry.mjs";
import { fail, failLocal, reportLocalOrSdkError } from "./sdk-errors.mjs";
import { normalizeArgv, assertKnownFlags, flagValue } from "./argparse.mjs";

/** Value-taking flags — the flag set doctor actually parses; anything else is BAD_USAGE via assertKnownFlags, never silently ignored. */
const DOCTOR_VALUE_FLAGS = ["--scan-dir", "--dir", "--manifest", "--buzz-agent", "--project", "--only"];

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
  run402 doctor [--verbose] [--refresh] [--no-scan] [--scan-dir <D>] [--project <project_id>]
                [--only <check> ...]
  run402 --wallet <profile> doctor --buzz --buzz-agent <npub-or-hex>

Output:
  Stdout is a JSON report:
    { ok,
      blocking: [{ check, status, message, hint? }],
      warnings: [{ check, code?, message, hint? }],
      checks:   [{ name, status, severity, value?, hint?, message? }] }
  \`ok\` answers ONE question — can this agent ship from here — and is true
  exactly when \`blocking[]\` is empty. Every check carries a \`severity\`:
    blocking  would stop a deploy: config_dir / wallet missing or error,
              api_reachable error, tier inactive / frozen / past_due /
              dormant / missing / error, error-severity source_scan findings
    advisory  a warning that never stops a deploy: account_health,
              recovery_posture, vault, runtime_staleness, retiring_routes,
              cli_update gaps
    info      ok / skipped / unknown
  Agents: branch on \`ok\`; read \`warnings[]\` (one entry per gap) for the
  non-blocking gaps and \`blocking[]\` for what to fix when \`ok\` is false.
  \`--only\` and \`--refresh\` runs have the same shape. The tier check's
  status is a fixed vocabulary — ok | inactive | frozen | past_due | dormant
  | purged | missing | unknown | error — never a tier name; the tier name
  and raw lifecycle ride in value.tier / value.lifecycle.
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
  --dir D        Select the application directory for deployment diagnostics.
  --manifest P   Explicitly select a manifest (executable configs are trusted code).
  --scan-dir D   Advanced arbitrary scan; does not claim deployment readiness
  --project <project_id> Target THIS project's vault check instead of the repo-standing
                 default (the 4.38.0 pin / run402 remote / RUN402_PROJECT_ID / active
                 project, in that order — see \`vault-target.mjs\`). Scoped to the
                 vault check only; every other check is wallet/machine-wide, not
                 per-project, and is unaffected by this flag. Composes with --only.
  --only <check> Run ONLY the named check (repeatable — pass it more than once
                 to run several). Every other check, INCLUDING the monorepo
                 source-tree scan, is suppressed rather than merely hidden: a
                 skipped check's network/filesystem work never runs at all, so
                 \`doctor --only vault\` costs one vault read, not a
                 config/tier/account/scan sweep. An unknown check name is
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
  - Wallet is configured and on a valid rail (x402 / mpp)
  - Keystore has at least one wallet
  - API_BASE is reachable (network check via /health)
  - Active tier resolves and is not 'past_due' / 'frozen' / 'dormant'. A wallet
    whose OWN organization holds no tier but that can reach projects owned by
    another organization (membership or grant) reports status 'missing' as an
    advisory, not a blocker — deploys to those projects are unaffected.
  - Function runtime staleness: deployed functions running an older platform
    runtime than the current gateway build (refresh with 'run402 functions
    rebuild --all'; re-bundles from your stored source, no source change)
  - Recovery posture: per vault-owning org, whether a human owner has a
    working control-plane login and whether any member holds a working
    source-access key (wrapper custody), plus a legacy-custody warning —
    the org's disaster backstops if the agent machine dies. Evidence
    levels: "configured" is what the platform verified, never proof an
    off-platform passkey or saved code still exists.
  - vault: the active project's vault — activation policy, whether THIS
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
  Buzz mode is read-only and skips the ordinary wallet, tier, project,
  account, runtime-staleness, and source-tree checks.

Exit codes:
  0  — ok: true (advisory warnings never change the exit code)
  1  — ok: false (one or more blocking checks; see blocking[])
`;

/**
 * A bounded LOCAL probe of the resident vault helper engine: `{running:false}`
 * is a fine answer, never a finding (the helper is an accelerator, not a
 * dependency). Reported inside the vault check's `value.daemon`.
 */
async function daemonStatus() {
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
}

export async function run(sub, args = []) {
  const all = normalizeArgv([sub, ...args].filter(Boolean));
  if (all.includes("--help") || all.includes("-h")) {
    console.log(HELP);
    return;
  }
  assertKnownFlags(all, ["--verbose", "--refresh", "--no-scan", "--buzz", ...DOCTOR_VALUE_FLAGS], DOCTOR_VALUE_FLAGS);

  // --only <check>, repeatable. Validated ABOVE the buzz branch, so an unknown
  // name is BAD_USAGE whichever mode was also requested.
  const onlyChecks = collectRepeatableFlag(all, "--only");
  try {
    assertDoctorCheckNames(onlyChecks);
  } catch (err) {
    failLocal(err);
  }
  // Buzz mode is a separate, always-complete report shape: an --only there
  // would be accepted but inert, so the combination is refused.
  if (onlyChecks.length > 0 && all.includes("--buzz")) {
    fail({
      code: "BAD_USAGE",
      message: "--only is not used with --buzz — buzz mode runs its own fixed, always-complete check set.",
      hint: "Drop --buzz to scope the ordinary check set with --only, or drop --only to run every buzz check.",
      details: { only: onlyChecks },
    });
  }

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

  let report;
  try {
    report = await getSdk().doctor({
      verbose: all.includes("--verbose"),
      refresh: all.includes("--refresh"),
      noScan: all.includes("--no-scan"),
      scanDir: flagValue(all, "--scan-dir"),
      dir: flagValue(all, "--dir"),
      manifest: flagValue(all, "--manifest"),
      // Scoped to the vault check: every other check is wallet/machine-wide.
      project: flagValue(all, "--project"),
      only: onlyChecks,
      cliUpdate: doctorUpdateCheck,
      daemonStatus,
    });
  } catch (err) {
    reportLocalOrSdkError(err);
    return;
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
