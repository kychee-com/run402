/**
 * Operator auth-mode resolution for the CLI edge.
 *
 * Runs at the top of cli.mjs (alongside the wallet-flag split) BEFORE any
 * subcommand module is loaded. Strips the global `--operator` / `--as-operator`
 * flag out of argv (so the subcommand parser never sees it) and translates it
 * into `RUN402_AUTH_MODE=operator`. `getSdk()` reads that env var — the single
 * chokepoint — and forces the control-plane (operator) Bearer instead of the
 * wallet allowance, even when a wallet is present.
 *
 * Why a flag→env translation (mirroring `--wallet` in wallet-context.mjs):
 * `getSdk()` is constructed fresh per subcommand and has no access to argv, so
 * the edge publishes the selection through the env. A directly-set
 * `RUN402_AUTH_MODE=operator` works on its own; the flag, when present, wins
 * (it is set last).
 *
 * Background: owner-only control-plane mutations (e.g. `run402 org member add`)
 * are owner-gated + step-up. In the default `auto` mode the resolver signs with
 * the active wallet's SIWX principal whenever a wallet allowance exists, so the
 * request goes out as the wallet — not the human operator who owns the org —
 * and the gateway returns 403. `--operator` makes the request carry the cached,
 * write-capable control-plane session instead.
 */

/** Boolean global flag (no value). Both spellings accepted. */
const OPERATOR_FLAGS = new Set(["--operator", "--as-operator"]);

/**
 * Split the global `--operator` / `--as-operator` flag out of argv. Pure: no
 * env mutation, no side effects. Returns the cleaned argv and whether the flag
 * was present (any occurrence ⇒ true). Mirrors `splitWalletFlag`'s contract so
 * the subcommand's `assertKnownFlags` never rejects the global flag.
 */
export function splitOperatorFlag(rawArgv = []) {
  const argv = [];
  let operator = false;
  for (const a of rawArgv) {
    if (typeof a === "string" && OPERATOR_FLAGS.has(a)) {
      operator = true;
      continue;
    }
    argv.push(a);
  }
  return { argv, operator };
}

/**
 * Edge translation: strip the global operator flag and, when present, publish
 * `RUN402_AUTH_MODE=operator` so `getSdk()` forces the control-plane Bearer.
 * The flag wins over any pre-existing env value (set last). Returns the
 * operator-stripped argv and the resolved boolean.
 */
export function applyAuthModeSelection({ rawArgv = [], env = process.env } = {}) {
  const { argv, operator } = splitOperatorFlag(rawArgv);
  if (operator) env.RUN402_AUTH_MODE = "operator";
  return { argv, operator };
}
