/**
 * `run402 doctor --buzz`: the CLI edge of `r.buzz.doctor()` (`@run402/sdk/node`),
 * which owns the zero-mutation Buzz setup preflight (`run402.buzz-doctor.v1`).
 * This module parses the `--buzz` / `--buzz-agent` argv and supplies what only
 * the executing CLI knows about itself — its version, how it was installed,
 * and its update check — as the `run402_cli` check's hooks.
 */
import { normalizeNostrSubject } from "#sdk/node";
import { getSdk } from "./sdk.mjs";
import { currentRun402Version, detectInstallContext, doctorUpdateCheck } from "./update-check.mjs";

/**
 * Parse `--buzz` / `--buzz-agent <npub-or-hex>` out of normalized argv.
 * Returns `{ buzz, expectedSubjectHex }` or `{ error }` (a `fail()` envelope).
 */
export function parseBuzzDoctorArgs(all = []) {
  const buzzIndexes = indexesOf(all, "--buzz");
  const agentIndexes = indexesOf(all, "--buzz-agent");
  if (agentIndexes.length > 0 && buzzIndexes.length === 0) {
    return { error: usageError("BUZZ_MODE_REQUIRED", "--buzz-agent requires --buzz", "--buzz-agent") };
  }
  if (buzzIndexes.length > 1) return { error: usageError("DUPLICATE_FLAG", "--buzz may be supplied only once", "--buzz") };
  if (agentIndexes.length > 1) return { error: usageError("DUPLICATE_FLAG", "--buzz-agent may be supplied only once", "--buzz-agent") };
  if (buzzIndexes.length === 0) return { buzz: false, expectedSubjectHex: null };
  let expectedSubjectHex = null;
  if (agentIndexes.length === 1) {
    const raw = all[agentIndexes[0] + 1];
    if (!raw || raw.startsWith("--")) {
      return { error: usageError("BAD_FLAG", "--buzz-agent requires an npub or 64-character hex value", "--buzz-agent") };
    }
    expectedSubjectHex = normalizeNostrSubject(raw);
    if (!expectedSubjectHex) {
      return { error: usageError("BAD_BUZZ_AGENT", "--buzz-agent must be an npub or 64-character hex public key", "--buzz-agent") };
    }
  }
  return { buzz: true, expectedSubjectHex };
}

/**
 * The Buzz doctor report for this CLI. `updateCheck` overrides the CLI's own
 * update check; every other option passes through to `r.buzz.doctor()`.
 */
export async function buildBuzzDoctorReport({ updateCheck = doctorUpdateCheck, ...opts } = {}) {
  return getSdk().buzz.doctor({
    run402Cli: { currentVersion: currentRun402Version, detectInstall: detectInstallContext, updateCheck },
    ...opts,
  });
}

function usageError(code, message, flag) {
  return { code, message, details: { flag }, retryable: false, safe_to_retry: true };
}

function indexesOf(values, expected) {
  return values.flatMap((value, index) => value === expected ? [index] : []);
}
