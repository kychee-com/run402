/**
 * CLI-side SDK getter.
 *
 * Constructs a fresh Node-flavored SDK on each call. Each CLI invocation is
 * typically a single process, so a fresh instance per subcommand is cheap
 * and sidesteps stale-env issues in tests that mutate RUN402_CONFIG_DIR /
 * RUN402_API_BASE between runs.
 */

import { run402 } from "#sdk/node";

export function getSdk(opts = {}) {
  // surface: "cli" opts the default credential resolution into `auto` — wallet
  // if present, else the operator (control-plane) session + matched approval.
  return run402({ surface: "cli", ...opts });
}
