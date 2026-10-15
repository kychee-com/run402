/**
 * CLI-side SDK getter.
 *
 * Constructs a fresh Node-flavored SDK on each call. Each CLI invocation is
 * typically a single process, so a fresh instance per subcommand is cheap
 * and sidesteps stale-env issues in tests that mutate RUN402_CONFIG_DIR /
 * RUN402_API_BASE between runs.
 */

import { run402 } from "#sdk/node";
import { fail } from "./sdk-errors.mjs";

// The SDK's AuthMode enum (sdk/src/node/credentials.ts). The CLI exposes this
// via RUN402_AUTH_MODE (and the global --operator flag, which sets it to
// "operator"). Kept in sync with the SDK type; "operator" / "wallet" are the
// useful overrides, "auto" is the CLI default, "none" strips auth entirely.
const VALID_AUTH_MODES = new Set(["auto", "wallet", "operator", "none"]);

/**
 * Resolve the credential mode from RUN402_AUTH_MODE — the single chokepoint the
 * global `--operator` flag (set at the CLI edge in auth-mode.mjs) and a directly
 * exported env var both flow through. Returns `undefined` when unset, so
 * `getSdk()` falls back to the surface-derived default (`cli` → `auto`). An
 * invalid value fails fast with a structured envelope rather than silently
 * ignoring a typo and leaving owner-only ops 403ing.
 */
function authModeFromEnv() {
  const raw = process.env.RUN402_AUTH_MODE;
  if (raw === undefined || raw.trim() === "") return undefined;
  const mode = raw.trim().toLowerCase();
  if (!VALID_AUTH_MODES.has(mode)) {
    fail({
      code: "BAD_ENV",
      message: `Invalid RUN402_AUTH_MODE=${JSON.stringify(raw)}.`,
      hint:
        `Valid modes: ${[...VALID_AUTH_MODES].join(", ")}. ` +
        "Use 'operator' (or the --operator flag) to force the control-plane session for owner-only control-plane ops.",
      details: { value: raw, valid: [...VALID_AUTH_MODES] },
    });
  }
  return mode;
}

export function getSdk(opts = {}) {
  // surface: "cli" opts the default credential resolution into `auto` — wallet
  // if present, else the operator (control-plane) session + matched approval.
  // RUN402_AUTH_MODE (set directly, or by the global --operator flag at the CLI
  // edge) forces a specific mode: "operator" makes owner-only control-plane
  // mutations go out under the control-plane Bearer even when a wallet allowance
  // is present. An explicit opts.authMode still wins.
  return run402({ surface: "cli", authMode: authModeFromEnv(), ...opts });
}
