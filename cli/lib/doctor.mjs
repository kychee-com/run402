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
import { CONFIG_DIR, readAllowance, loadKeyStore } from "./config.mjs";
import { getSdk } from "./sdk.mjs";

const HELP = `run402 doctor — Health and config diagnostics

Usage:
  run402 doctor [--json] [--verbose]

Options:
  --json       Emit a structured JSON report on stdout
  --verbose    Include extra detail (timing, error messages)

Checks performed:
  - Config directory exists and is writable
  - Allowance is configured and on a valid rail (x402 / mpp)
  - Keystore has at least one wallet
  - API_BASE is reachable (network check via /health)
  - Active tier resolves and is not 'past_due' / 'frozen'

Exit codes:
  0  — all checks pass
  1  — one or more checks failed (details in output)
`;

export async function run(sub, args = []) {
  const all = [sub, ...args].filter(Boolean);
  if (all.includes("--help") || all.includes("-h")) {
    console.log(HELP);
    return;
  }
  const json = all.includes("--json");
  const verbose = all.includes("--verbose");

  const checks = [];

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
          // checking for config presence don't need wallet details.
          ...(verbose && { details: allowance }),
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

  // 3. Keystore.
  try {
    const keystore = loadKeyStore();
    const walletCount = Object.keys(keystore?.wallets ?? {}).length;
    checks.push({
      name: "keystore",
      status: walletCount > 0 ? "ok" : "empty",
      value: { wallet_count: walletCount },
      ...(walletCount === 0 && {
        hint: "Run 'run402 init' to generate a wallet.",
      }),
    });
  } catch (err) {
    checks.push({
      name: "keystore",
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
    if (tierName && tierName !== "past_due" && tierName !== "frozen" && tierName !== "dormant") {
      checks.push({
        name: "tier",
        status: "ok",
        value: { tier: tierName },
      });
    } else {
      checks.push({
        name: "tier",
        status: tierName ?? "missing",
        ...(tierName && {
          hint: "Run 'run402 tier set prototype' to subscribe (or upgrade).",
        }),
      });
    }
  } catch (err) {
    checks.push({
      name: "tier",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 6. Operator health snapshot (v1.55).
  try {
    const sdk = getSdk();
    const status = await sdk.admin.getOperatorStatus();
    const gaps = [];
    if (status.operator_contact.email_status !== "verified") {
      gaps.push(`operator email not verified (${status.operator_contact.email_status}) — run 'run402 agent contact --email ...' then reply to the challenge`);
    }
    if (status.operator_contact.passkey_status !== "verified") {
      gaps.push("operator passkey not bound — run 'run402 agent passkey enroll' after email verification");
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
  } catch (err) {
    // Operator status endpoint may not be reachable if the operator-binding
    // substrate isn't deployed yet on the target API. Don't fail the whole
    // doctor over it — emit as a soft warning.
    checks.push({
      name: "operator_health",
      status: "skipped",
      message: err instanceof Error ? err.message : String(err),
      ...(verbose && { hint: "GET /agent/v1/operator/status not reachable; requires v1.55+ gateway." }),
    });
  }

  // 'warning' counts as ok for exit-code purposes — gaps are surfaced in
  // output but don't fail the doctor. Only hard 'error' / 'missing' /
  // 'empty' fail.
  const allOk = checks.every((c) => c.status === "ok" || c.status === "warning" || c.status === "skipped");

  if (json) {
    console.log(JSON.stringify({ ok: allOk, checks }, null, 2));
  } else {
    console.log(`Run402 doctor — ${allOk ? "all checks passed" : "issues found"}`);
    console.log("");
    for (const c of checks) {
      const icon =
        c.status === "ok" ? "✓"
        : c.status === "warning" ? "⚠"
        : c.status === "skipped" ? "·"
        : c.status === "missing" || c.status === "empty" ? "⚠"
        : "✗";
      const status = c.status === "ok" ? "ok" : c.status;
      console.log(`  ${icon} ${c.name.padEnd(16)} ${status}`);
      if (c.hint) console.log(`     → ${c.hint}`);
      if (c.message) console.log(`     ${c.message}`);
      if (c.value && c.value.gaps && Array.isArray(c.value.gaps)) {
        for (const gap of c.value.gaps) console.log(`     • ${gap}`);
      }
    }
  }

  process.exit(allOk ? 0 : 1);
}
