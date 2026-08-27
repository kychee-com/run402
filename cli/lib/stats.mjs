/**
 * CLI-edge request observability (Observability: RUN402_TRACE + always-on
 * stats + -v).
 *
 * `sdk/src/kernel.ts` accumulates round trips / wire time / bytes on each
 * `Run402` instance's client (`sdk.stats()`), and — when `RUN402_TRACE` is
 * set — writes one `r402 <METHOD> <path> -> <status> <ms>ms attempt=<n>`
 * line per request to stderr, automatically, for every SDK caller (CLI, MCP,
 * `git-remote-run402`). This module is the thin CLI-edge reader of that
 * per-instance accumulator: it turns `sdk.stats()` into the `stats` envelope
 * field every `repos` verb's result and `deploy apply`'s final result carry
 * (always on), plus the `-v`/`--verbose` stderr summary line.
 *
 * `sdk.stats()` reflects only calls made through the ONE `Run402` instance
 * it is read from. Callers should resolve a single `sdk = getSdk()` and
 * reuse it for a verb's own direct SDK calls to get an accurate count;
 * calls a shared cross-cutting helper (org resolution, wallet context, …)
 * makes through its own internal SDK instance are not reflected here — a
 * known, deliberate scoping choice (see AGENTS.md / the observability
 * change notes), not a bug.
 */

const EMPTY_STATS = Object.freeze({ round_trips: 0, wire_ms: 0, bytes_up: 0, bytes_down: 0 });

/** `sdk.stats()`, defensively — never throws even against a test double that doesn't implement it. */
export function sdkStats(sdk) {
  const s = typeof sdk?.stats === "function" ? sdk.stats() : null;
  if (!s || typeof s !== "object") return { ...EMPTY_STATS };
  return {
    round_trips: Number(s.round_trips ?? 0),
    wire_ms: Number(s.wire_ms ?? 0),
    bytes_up: Number(s.bytes_up ?? 0),
    bytes_down: Number(s.bytes_down ?? 0),
  };
}

/** `-v` or `--verbose` present in normalized argv. */
export function isVerbose(a) {
  return Array.isArray(a) && (a.includes("-v") || a.includes("--verbose"));
}

function writeVerboseStatsLine(sdk) {
  const s = sdkStats(sdk);
  console.error(`stats: round_trips=${s.round_trips} wire_ms=${s.wire_ms} bytes_up=${s.bytes_up} bytes_down=${s.bytes_down}`);
}

/**
 * One stderr summary line, only when verbose was requested. Coexists with
 * `--human`. `verbose` is either normalized argv (checked for `-v`/
 * `--verbose`) or a plain boolean, for callers (e.g. `deploy apply`) that
 * already parsed their own flags into an options object.
 */
export function printVerboseStats(verbose, sdk) {
  const on = Array.isArray(verbose) ? isVerbose(verbose) : Boolean(verbose);
  if (!on) return;
  writeVerboseStatsLine(sdk);
}
