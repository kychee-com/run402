/**
 * `r.doctor()` — local health and configuration diagnostics, owned by the
 * Node SDK: config directory, wallet, local project keys, API reachability,
 * tier and organization lifecycle, account health, function runtime
 * staleness, recovery posture, the vault, and the scoped source scan.
 *
 * The report is `{ ok, blocking[], warnings[], checks[] }`. `ok` answers ONE
 * question — can this agent ship from here — and is true exactly when
 * `blocking[]` is empty. Every check carries a `severity`:
 *   blocking  would stop a deploy
 *   advisory  a gap worth surfacing that never stops a deploy (`warnings[]`)
 *   info      nothing to act on
 * A status outside the known vocabulary fails closed as blocking.
 *
 * `run402 doctor` is a shim over this; the checks that belong to the calling
 * program itself (whether the installed CLI is current, its resident vault
 * helper) are hooks the caller supplies.
 */

import { existsSync, statSync } from "node:fs";
import { getConfigDir } from "../../core-dist/config.js";
import { readWallet } from "../../core-dist/wallet.js";
import { loadKeyStore } from "../../core-dist/keystore.js";
import { LocalError } from "../errors.js";
import { VAULT_BYO_NO_PAYLOAD_COPY_STATEMENT } from "../namespaces/vault.crypto.js";
import type { Run402 } from "../index.js";
import { resolveApplicationScope, loadApplicationScanInput } from "./app-scope.js";
import { resolveScanRoot, scanDeploymentSources, scanSourceTree, SCAN_SEVERITY } from "./source-scan.js";
import { resolveVaultTarget } from "./vault-target.js";

/**
 * The stable, complete registry of ordinary-mode check names, in the order
 * each normally runs: the one list `only` validates against.
 */
export const DOCTOR_CHECK_NAMES = [
  "config_dir",
  "cli_update",
  "wallet",
  "projects",
  "api_reachable",
  "tier",
  "account_health",
  "runtime_staleness",
  "recovery_posture",
  "vault",
  "source_scan",
] as const;

export type DoctorCheckName = (typeof DOCTOR_CHECK_NAMES)[number];
export type DoctorSeverity = "blocking" | "advisory" | "info";

/** One check as a check function produces it; `severity` is derived when absent. */
export interface DoctorCheck {
  name: string;
  status: string;
  severity?: DoctorSeverity;
  value?: unknown;
  hint?: string;
  message?: string;
  code?: string;
  [key: string]: unknown;
}

export interface DoctorReportCheck extends DoctorCheck {
  severity: DoctorSeverity;
}

export interface DoctorReport {
  ok: boolean;
  blocking: Array<{ check: string; status: string; message: string; hint?: string }>;
  warnings: Array<{ check: string; code?: string; message: string; hint?: string }>;
  checks: DoctorReportCheck[];
}

export interface DoctorOptions {
  /** Include extra detail (timing, wallet details without secrets). */
  verbose?: boolean;
  /** Force a live update check in the `cliUpdate` hook. */
  refresh?: boolean;
  /** Skip the source-tree scan. */
  noScan?: boolean;
  /** Advanced arbitrary scan directory; does not claim deployment readiness. */
  scanDir?: string | null;
  /** Application directory for deployment diagnostics. */
  dir?: string | null;
  /** Explicit manifest for deployment diagnostics. */
  manifest?: string | null;
  /** Target THIS project's vault check (scoped to the vault check only). */
  project?: string | null;
  /** Run only these checks; every other check's work is skipped entirely. */
  only?: string[];
  /** Directory the vault targeting and application scope start from. Default `process.cwd()`. */
  cwd?: string;
  /**
   * The calling program's own update check, producing the `cli_update`
   * check. Absent: `cli_update` reports `skipped`.
   */
  cliUpdate?: (opts: { refresh: boolean }) => Promise<DoctorCheck>;
  /**
   * The calling program's resident vault helper, reported inside the vault
   * check's `value.daemon`. Absent: no `daemon` field.
   */
  daemonStatus?: () => Promise<Record<string, unknown>>;
  /** Receives the one-line warning when `project` disagrees with the repository's own remote. */
  warn?: (line: string) => void;
}

const INFO_STATUSES = new Set(["ok", "skipped", "unknown"]);
const TIER_LIFECYCLE_STATUSES = new Set(["past_due", "frozen", "dormant", "purged"]);

function severityOf(check: DoctorCheck): DoctorSeverity {
  if (check.severity === "blocking" || check.severity === "advisory" || check.severity === "info") return check.severity;
  if (INFO_STATUSES.has(check.status)) return "info";
  if (check.status === "warning") return "advisory";
  return "blocking";
}

/** Stable codes for advisory checks that report ONE finding (no `value.gaps`). */
const ADVISORY_CODES: Record<string, string> = {
  cli_update: "CLI_UPDATE_AVAILABLE",
  runtime_staleness: "FUNCTION_RUNTIME_STALE",
  source_scan: "SOURCE_SCAN_WARNINGS",
  tier: "TIER_MISSING_ON_OWN_ORG",
};

/**
 * Fold per-check results into `{ ok, blocking[], warnings[], checks[] }`:
 * one warning per gap string of every advisory check (one for an advisory
 * check with no gaps), one blocking entry per blocking check. Pure.
 */
export function buildDoctorReport(rawChecks: DoctorCheck[]): DoctorReport {
  const checks = rawChecks.map((check) => {
    const { name, status, severity: _pinned, ...rest } = check;
    return { name, status, severity: severityOf(check), ...rest } as DoctorReportCheck;
  });
  const blocking: DoctorReport["blocking"] = [];
  const warnings: DoctorReport["warnings"] = [];
  for (const check of checks) {
    if (check.severity === "blocking") {
      blocking.push({
        check: check.name,
        status: check.status,
        message: check.message ?? `${check.name}: ${check.status}`,
        ...(check.hint && { hint: check.hint }),
      });
      continue;
    }
    if (check.severity !== "advisory") continue;
    const value = check.value as { gaps?: unknown } | undefined;
    const gaps = Array.isArray(value?.gaps) ? (value!.gaps as unknown[]).filter((g): g is string => typeof g === "string" && g.length > 0) : [];
    if (gaps.length > 0) {
      for (const gap of gaps) warnings.push({ check: check.name, message: gap, ...(check.hint && { hint: check.hint }) });
    } else {
      const code = check.code ?? ADVISORY_CODES[check.name];
      const message = check.message ?? check.hint ?? `${check.name}: ${check.status}`;
      warnings.push({
        check: check.name,
        ...(code && { code }),
        message,
        ...(check.hint && check.hint !== message && { hint: check.hint }),
      });
    }
  }
  return { ok: blocking.length === 0, blocking, warnings, checks };
}

/** Refuse an `only` name outside {@link DOCTOR_CHECK_NAMES} (`BAD_USAGE`, listing the valid names). */
export function assertDoctorCheckNames(names: readonly string[]): void {
  for (const name of names) {
    if (!(DOCTOR_CHECK_NAMES as readonly string[]).includes(name)) {
      throw new LocalError(`Unknown doctor check: '${name}'.`, "running doctor", {
        code: "BAD_USAGE",
        hint: `Valid check names: ${DOCTOR_CHECK_NAMES.join(", ")}.`,
        details: { check: name, known_checks: [...DOCTOR_CHECK_NAMES] },
      });
    }
  }
}

function redactWalletForDiagnostics(localWallet: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = { ...localWallet };
  delete safe.privateKey;
  if (typeof safe.funded === "boolean") safe.faucet_used = safe.funded;
  delete safe.funded;
  return safe;
}

/**
 * A check-failure message, context first: the SDK's `<message> while
 * <context>` reads as two jammed fragments, so the trailing context is cut
 * and the check label leads.
 */
function describeCheckFailure(label: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const context = typeof (err as { context?: unknown })?.context === "string" && ((err as { context: string }).context).length > 0
    ? (err as { context: string }).context
    : null;
  let reason = raw;
  if (context) {
    const marker = ` while ${context}`;
    const idx = raw.indexOf(marker);
    if (idx !== -1) reason = (raw.slice(0, idx) + raw.slice(idx + marker.length)).trim();
  }
  return `${label} failed: ${reason}`;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Run the ordinary-mode checks against `r` and fold them into the report. */
export async function runDoctor(r: Run402, opts: DoctorOptions = {}): Promise<DoctorReport> {
  const verbose = opts.verbose === true;
  const refresh = opts.refresh === true;
  const cwd = opts.cwd ?? process.cwd();
  const only = new Set(opts.only ?? []);
  assertDoctorCheckNames([...only]);
  const wanted = (name: DoctorCheckName) => only.size === 0 || only.has(name);

  const checks: DoctorCheck[] = [];
  const CONFIG_DIR = getConfigDir();

  // 1. Config directory.
  if (wanted("config_dir")) try {
    if (existsSync(CONFIG_DIR) && statSync(CONFIG_DIR).isDirectory()) {
      checks.push({ name: "config_dir", status: "ok", value: CONFIG_DIR });
    } else {
      checks.push({ name: "config_dir", status: "missing", value: CONFIG_DIR, hint: "Run 'run402 init' to set up the config directory." });
    }
  } catch (err) {
    checks.push({ name: "config_dir", status: "error", message: message(err) });
  }

  // 1b. The calling program's update state: advisory, never hides the rest.
  if (wanted("cli_update")) {
    if (opts.cliUpdate) {
      try {
        checks.push(await opts.cliUpdate({ refresh }));
      } catch (err) {
        checks.push({ name: "cli_update", status: "unknown", message: message(err) });
      }
    } else {
      checks.push({ name: "cli_update", status: "skipped", message: "No CLI update check on this surface." });
    }
  }

  // 2. Wallet.
  let walletConfigured = false;
  if (wanted("wallet")) try {
    const localWallet = readWallet();
    if (localWallet) {
      walletConfigured = true;
      checks.push({
        name: "wallet",
        status: "ok",
        value: {
          rail: localWallet.rail,
          // Never keystore secrets, even verbose.
          ...(verbose && { details: redactWalletForDiagnostics(localWallet as unknown as Record<string, unknown>) }),
        },
      });
    } else {
      checks.push({ name: "wallet", status: "missing", hint: "Run 'run402 init' to create a wallet." });
    }
  } catch (err) {
    checks.push({ name: "wallet", status: "error", message: message(err) });
  }

  // 3. Local project keys (the wallet itself is check 2). Empty is normal.
  if (wanted("projects")) try {
    const keystore = loadKeyStore();
    const projectCount = Object.keys(keystore?.projects ?? {}).length;
    checks.push({
      name: "projects",
      status: "ok",
      value: { project_count: projectCount },
      ...(projectCount === 0 && {
        hint: walletConfigured
          ? "No projects yet — run 'run402 projects provision' to create one (wallet is already set up)."
          : "No projects yet — run 'run402 init' to set up the wallet first, then 'run402 projects provision'.",
      }),
    });
  } catch (err) {
    checks.push({ name: "projects", status: "error", message: message(err) });
  }

  // 4. API reachability (read-only, unauthenticated).
  if (wanted("api_reachable")) try {
    const t0 = Date.now();
    await r.service.status();
    const elapsed = Date.now() - t0;
    checks.push({ name: "api_reachable", status: "ok", ...(verbose && { value: { elapsed_ms: elapsed } }) });
  } catch (err) {
    checks.push({
      name: "api_reachable",
      status: "error",
      message: message(err),
      hint: "Check the RUN402_API_BASE env var and your network connection.",
    });
  }

  // 5. Tier. `status` is a FIXED vocabulary — ok | inactive | frozen |
  // past_due | dormant | purged | missing | unknown | error — never a tier
  // name; the name and raw lifecycle ride in value.
  if (wanted("tier")) try {
    const tier = (await r.tier.status()) as unknown as Record<string, unknown> | null;
    const tierName = typeof tier?.tier === "string" && (tier.tier as string).length > 0 ? (tier.tier as string) : null;
    const lifecycle = typeof tier?.organization_lifecycle_state === "string" && (tier.organization_lifecycle_state as string).length > 0
      ? (tier.organization_lifecycle_state as string)
      : null;
    const active = tier?.active === true;
    // A wallet whose own org holds no tier can still ship into another org's
    // projects, so "missing" blocks only when there is nowhere to ship.
    const reachableProjects = Array.isArray(tier?.projects) ? (tier!.projects as unknown[]).length : 0;
    let status: string;
    if (lifecycle !== null && lifecycle !== "active") {
      status = TIER_LIFECYCLE_STATUSES.has(lifecycle) ? lifecycle : "inactive";
    } else if (tierName === null) {
      status = "missing";
    } else if (!active) {
      status = "inactive";
    } else if (lifecycle === null) {
      status = "unknown";
    } else {
      status = "ok";
    }
    const value = {
      tier: tierName,
      lifecycle,
      active,
      organization_lifecycle_state: lifecycle,
      lease_expires_at: tier?.lease_perpetual === true ? null : tier?.lease_expires_at ?? null,
      reachable_projects: reachableProjects,
    };
    if (status === "ok") {
      checks.push({ name: "tier", status, value });
    } else if (status === "missing" && reachableProjects > 0) {
      checks.push({
        name: "tier",
        status,
        severity: "advisory",
        value,
        message: `this wallet's own organization holds no tier, but it can reach ${reachableProjects} project(s) owned by another organization (membership or grant) — deploys to those are unaffected`,
        hint: "Run 'run402 tier set prototype' only if you want to provision projects under this wallet's own organization.",
      });
    } else {
      checks.push({
        name: "tier",
        status,
        value,
        message: status === "unknown"
          ? "tier resolved, but the organization lifecycle could not be determined"
          : status === "missing"
            ? "no tier on this wallet's organization and no reachable project — nothing can be provisioned or deployed from here"
            : status === "inactive"
              ? `tier '${tierName ?? "(none)"}' is not active${lifecycle && lifecycle !== "active" ? ` (organization lifecycle '${lifecycle}')` : ""}`
              : `organization lifecycle is '${lifecycle}' — the control plane is gated until the tier is reactivated`,
        hint: status === "unknown"
          ? "Tier resolved, but organization lifecycle could not be determined. Check `run402 tier status` before assuming the account is healthy."
          : "Run 'run402 tier set prototype' to set, renew, or reactivate the tier.",
      });
    }
  } catch (err) {
    checks.push({ name: "tier", status: "error", message: describeCheckFailure("tier status check", err) });
  }

  // 6. Account health, runtime staleness, and recovery posture all ride ONE
  // `GET /agent/v1/me/status` read, skipped entirely when none is wanted.
  if (wanted("account_health") || wanted("runtime_staleness") || wanted("recovery_posture")) try {
    const status = (await r.me.status()) as unknown as Record<string, any>;
    const gaps: string[] = [];
    if (status.contact.email_status !== "verified") {
      const ch = status.email_verification?.last_challenge;
      if (ch && ch.hint) {
        const attemptsLine = ch.attempt_count > 0
          ? ` (${ch.attempt_count}/${ch.attempt_count + ch.remaining_attempts} attempts used, ${ch.remaining_attempts} remaining)`
          : "";
        gaps.push(`contact email not verified${attemptsLine}: ${ch.hint}`);
      } else {
        gaps.push(`contact email not verified (${status.contact.email_status}) — run 'run402 agent contact --email ...' then reply to the challenge`);
      }
    }
    if (status.contact.passkey_status !== "verified") {
      gaps.push("contact passkey not bound — run 'run402 login' (or 'run402 agent passkey enroll') after email verification");
    }
    const reach = status.reachability;
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
      for (const item of status.critical_items) gaps.push(`${item.kind}: ${item.detail}`);
    }
    if (wanted("account_health")) {
      if (gaps.length > 0) {
        checks.push({
          name: "account_health",
          status: "warning",
          value: { gaps },
          hint: "Address the above gaps; they're what 'run402 notifications' is designed to surface.",
        });
      } else {
        checks.push({ name: "account_health", status: "ok" });
      }
    }

    // 6b. Function runtime staleness: a redeploy with unchanged source does
    // not refresh the platform wrapper; refreshing is opt-in.
    if (wanted("runtime_staleness")) {
      const runtime = status.runtime;
      if (runtime && typeof runtime.stale_function_count === "number") {
        if (runtime.stale_function_count > 0) {
          checks.push({
            name: "runtime_staleness",
            status: "warning",
            value: { stale_function_count: runtime.stale_function_count, stale_functions: runtime.stale_functions ?? [] },
            hint: `${runtime.stale_function_count} function(s) are running an older platform runtime. Run 'run402 functions rebuild --all' to refresh (re-bundles from your stored source; no source change).`,
          });
        } else {
          checks.push({ name: "runtime_staleness", status: "ok", value: { stale_function_count: 0 } });
        }
      } else {
        checks.push({
          name: "runtime_staleness",
          status: "skipped",
          ...(verbose && { hint: "account status has no 'runtime' block; requires v1.69+ gateway." }),
        });
      }
    }

    // 6c. Org recovery posture: evidence levels, never guarantees.
    if (wanted("recovery_posture")) {
      const posture = status.recovery_posture;
      if (!Array.isArray(posture)) {
        checks.push({
          name: "recovery_posture",
          status: "skipped",
          ...(verbose && { hint: "account status has no 'recovery_posture' block; requires a vault-recovery-custody gateway." }),
        });
      } else if (posture.length === 0) {
        checks.push({ name: "recovery_posture", status: "ok", value: { orgs: [] } });
      } else {
        const postureGaps: string[] = [];
        for (const org of posture) {
          const label = `org ${org.org_id} (${org.vault_count} vault${org.vault_count === 1 ? "" : "s"})`;
          if (org.control_plane_configured === false) {
            postureGaps.push(`${label}: no human owner with a working control-plane login — if this org's agent machine dies, nobody can sign in to recover it. Invite a backup human (run402 orgs invite create ${org.org_id} --email <their-email> --role owner) and have them complete login at console.run402.com.`);
          }
          if (org.source_backup_configured === false) {
            postureGaps.push(`${label}: no human member holds a working source-access key — vault history has no member-side decryption backup. Have a member complete source enrollment at console.run402.com/account → Source access.`);
          }
          if (org.custody_legacy_present === true) {
            postureGaps.push(`${label}: a member key is still on single-credential legacy custody (one passkey, no recovery code — losing that one credential loses source access). Re-enroll at console.run402.com/account to move to wrapper custody with a recovery code.`);
          }
        }
        checks.push(
          postureGaps.length > 0
            ? {
                name: "recovery_posture",
                status: "warning",
                value: { orgs: posture, gaps: postureGaps },
                hint: "These are the org's disaster-recovery backstops — the same facts arrive as org_recovery_posture_degraded/_recovered feed events. After enrolling, export the recovery bundle (run402 repos recovery-bundle) and store it separately from the code.",
              }
            : { name: "recovery_posture", status: "ok", value: { orgs: posture } },
        );
      }
    }
  } catch (err) {
    // An unreachable account status is a soft skip for all three checks it feeds.
    if (wanted("account_health")) checks.push({
      name: "account_health",
      status: "skipped",
      message: describeCheckFailure("account status check", err),
      ...(verbose && { hint: "GET /agent/v1/me/status not reachable." }),
    });
    if (wanted("runtime_staleness")) checks.push({ name: "runtime_staleness", status: "skipped", message: describeCheckFailure("account status check", err) });
    if (wanted("recovery_posture")) checks.push({ name: "recovery_posture", status: "skipped", message: describeCheckFailure("account status check", err) });
  }

  // 7. The vault: policy, whether THIS machine can produce the capture a
  // `required` policy demands, open override journals, mirror currency, and
  // where the keystore lives. Read-only and best-effort in every branch.
  if (wanted("vault")) {
    const daemonInfo = opts.daemonStatus ? await opts.daemonStatus().catch(() => ({ running: false })) : undefined;
    const target = await resolveVaultTarget(r.repos, { repoDir: cwd, explicitProjectId: opts.project ?? undefined, ...(opts.warn ? { warn: opts.warn } : {}) });
    const projectId = target.project_id ?? null;
    const repoId = target.repo_id ?? null;
    if (!projectId && !repoId) {
      checks.push({
        name: "vault",
        status: "skipped",
        ...(verbose && { hint: "no active project — run 'run402 projects use <project_id>' to check its vault." }),
      });
    } else {
      try {
        const gv = (await r.repos.status({
          ...(repoId ? { repo_id: repoId } : { project_id: projectId! }),
          repo_dir: cwd,
        })) as unknown as Record<string, any>;
        const value: Record<string, any> = {
          project_id: gv.project_id ?? projectId,
          repo_id: gv.repo_id,
          vault: gv.vault === null ? null : "allocated",
          storage_profile: gv.vault?.storage_profile ?? null,
          byo_destination: gv.vault?.byo_destination ?? null,
          vault_policy: gv.vault_policy,
          keystore_root: gv.keystore.root,
          can_sign: gv.keystore.can_sign,
          holds_repo_key: gv.keystore.holds_repo_key,
          pending_overrides: gv.pending_overrides,
          pins: gv.pins,
          remote: gv.remote,
          // null/<=1: the single-principal terminal-loss statement is honest;
          // >=2: a second covering recipient is proven.
          covering_recipients: gv.covering_recipients ?? null,
          ...(daemonInfo !== undefined ? { daemon: daemonInfo } : {}),
          // This machine's standing on the chain-verified writer set; the
          // read-only terminal state outranks it.
          writer: gv.vault === null
            ? null
            : gv.vault.read_only_terminal
              ? "read_only_vault"
              : gv.vault.writer_set?.writers.some((w: { writer_key_id: string }) => w.writer_key_id === gv.keystore.identity_fingerprint)
                ? "active"
                : gv.vault.pending_writers?.some((p: { writer_key_id: string }) => p.writer_key_id === gv.keystore.identity_fingerprint)
                  ? "pending"
                  : "not_admitted",
        };
        const gaps: string[] = [];
        if (value.writer === "read_only_vault") {
          gaps.push("this vault has lost its last writer (D228 read-only terminal) — it still serves reads, but no push can be admitted until a new writer is admitted through a recovery path");
        } else if (value.writer === "pending") {
          gaps.push("this machine's key is an eligible writer candidate but not yet admitted — run 'run402 repos access sync' if you already hold writer standing on this vault, or ask a current writer to run any vault operation");
        } else if (value.writer === "not_admitted") {
          gaps.push("this machine's key is not an active writer on this vault — a push from here is refused VAULT_WRITER_NOT_ADMITTED; ask a current writer to admit you (org membership at role developer+ and a published signing key make you eligible)");
        }
        if (gv.vault_policy === "required" && !gv.keystore.holds_repo_key) {
          gaps.push(
            "vault_policy is 'required' but this machine holds no key for the vault — a deploy from here is refused with VAULT_CLIENT_UPGRADE_REQUIRED. " +
            "Run 'run402 repos create --project <project_id>' (idempotent; resolves to the existing repo), or 'run402 repos policy grandfathered --reason <why>' to un-gate the project.",
          );
        } else if (gv.vault_policy === "required" && !gv.keystore.can_sign) {
          gaps.push("vault_policy is 'required' and this keystore is read-only (no signing key) — it can verify but cannot publish the capture a deploy needs");
        }
        if (gv.pending_overrides > 0) {
          gaps.push(`${gv.pending_overrides} unvaulted-override journal(s) are still open — run 'run402 repos capture' to drain them`);
        }
        // `matches` is tri-state: only `false` is a mismatch.
        if (gv.remote && gv.remote.matches === false) {
          gaps.push(`the '${gv.remote.name}' git remote points at a different project than ${value.project_id} (${gv.remote.url})`);
        }
        for (const w of gv.warnings ?? []) gaps.push(`${w.kind}: ${w.message}`);

        // Mirror currency, alongside (never in place of) the deploy gaps; only
        // STALE becomes a gap.
        if (gv.vault !== null && value.repo_id) {
          try {
            const mirrorStatus = (await r.repos.mirrorStatus({ repo_id: value.repo_id, is_byo: value.storage_profile === "byo" })) as unknown as Record<string, any>;
            value.vault_mirror = {
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
            // A mirror read failing is never a doctor failure.
          }
        }

        const byoDisclosure = value.storage_profile === "byo" ? ` Storage: byo (${value.byo_destination ?? "(unknown)"}) — ${VAULT_BYO_NO_PAYLOAD_COPY_STATEMENT}` : "";
        checks.push({
          name: "vault",
          status: gaps.length > 0 ? "warning" : "ok",
          value: gaps.length > 0 ? { ...value, gaps } : value,
          hint: (gv.vault === null
            ? `No vault for this project (that is a normal shape). Allocate one with 'run402 repos create --project <project_id>'. Keystore: ${gv.keystore.root}`
            : gv.durability_statement
              ? `Back up ${gv.keystore.root} anyway — ${gv.durability_statement} (covering_recipients: ${gv.covering_recipients})`
              : `Back up ${gv.keystore.root} — whole-machine or whole-keystore loss is terminal for vault history.`) + byoDisclosure,
        });
      } catch (err) {
        // A gateway without vaults, an unreachable API, or an unreadable
        // project is not a local health problem.
        checks.push({ name: "vault", status: "skipped", message: describeCheckFailure("vault status check", err) });
      }
    }
  }

  // 8. Source scan, scoped to the selected application. Error findings block
  // deploy; an explicit arbitrary scan directory is advisory only.
  if (!opts.noScan && wanted("source_scan")) {
    const scanDirOverride = opts.scanDir ?? null;
    try {
      const scope = await resolveApplicationScope({ ...(opts.cwd ? { cwd: opts.cwd } : {}), dir: opts.dir ?? undefined, manifest: opts.manifest ?? undefined });
      if (!scanDirOverride && !scope.selected) {
        checks.push({ name: "source_scan", status: "skipped", value: { scope: "unscoped", app_root: scope.app_root }, message: "No application selected. Run doctor --dir <app> or --manifest <path>; sibling applications are not deployment blockers." });
      } else {
        const scanRoot = scanDirOverride ?? resolveScanRoot(scope.app_root);
        const scanContext: Record<string, unknown> = { scope: scanDirOverride ? "explicit_scan_directory" : "application", app_root: scope.app_root, manifest_path: scope.manifest_path };
        let findings: Array<{ severity: string }>;
        if (scanDirOverride) findings = scanSourceTree(scanRoot, { cwd: scope.app_root });
        else {
          const selected = await loadApplicationScanInput(scope.manifest_path!);
          scanContext.build_outputs = selected.build_deferred ? "deferred_until_build" : "not_deferred";
          findings = scanDeploymentSources(selected.spec, scope.app_root).findings;
        }
        const errorFindings = findings.filter((f) => f.severity === SCAN_SEVERITY.ERROR);
        const warnFindings = findings.filter((f) => f.severity === SCAN_SEVERITY.WARN);
        if (findings.length === 0) {
          checks.push({ name: "source_scan", status: "ok", value: { ...scanContext, scan_root: scanRoot, file_count_with_findings: 0 } });
        } else {
          checks.push({
            name: "source_scan",
            status: errorFindings.length > 0 ? "error" : "warning",
            ...(scanDirOverride ? { severity: "advisory" as const } : {}),
            value: {
              ...scanContext,
              scan_root: scanRoot,
              findings: errorFindings.length + warnFindings.length,
              errors: errorFindings.length,
              warnings: warnFindings.length,
              details: findings,
            },
            hint: errorFindings.length > 0
              ? scanDirOverride ? "Findings are from the explicit arbitrary scan directory; they do not establish that an application deploy will be refused." : "Fix the findings in this application. The same scoped source scan gates up and deploy."
              : "Source scan emitted warnings (non-blocking). Review and address when convenient.",
          });
        }
      }
    } catch (err) {
      checks.push({
        name: "source_scan",
        status: "error",
        value: { code: (err as { code?: string })?.code ?? "APPLICATION_SCAN_FAILED", details: (err as { details?: unknown })?.details ?? null },
        message: message(err),
      });
    }
  }

  return buildDoctorReport(checks);
}
