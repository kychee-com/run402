/**
 * Deprecation notice for positional call shapes that have been superseded by
 * options-object / scope-handle forms (see the `sdk-call-shape-conventions`
 * change).
 *
 * Notices are emitted at most once per `method` per process, to **stderr only**
 * — never stdout, because the CLI's stdout is an agent-parsed JSON contract
 * (corrupting it would break callers). Suppress entirely with
 * `RUN402_SUPPRESS_DEPRECATIONS=1`.
 *
 * Isomorphic: uses `process.stderr` when available (Node), falls back to
 * `console.warn` (which is stderr-backed in Node and the dev console elsewhere),
 * and is a silent no-op when neither exists.
 */

const warned = new Set<string>();

export function deprecatePositional(method: string, hint?: string): void {
  if (warned.has(method)) return;
  warned.add(method);

  const proc = (globalThis as {
    process?: {
      env?: Record<string, string | undefined>;
      stderr?: { write?: (s: string) => unknown };
    };
  }).process;

  if (proc?.env?.RUN402_SUPPRESS_DEPRECATIONS) return;

  const message =
    `[run402] DEPRECATED: ${method} positional arguments are deprecated` +
    (hint ? `; ${hint}` : "") +
    `. This form will be removed in the next major; set RUN402_SUPPRESS_DEPRECATIONS=1 to silence.`;

  if (proc?.stderr?.write) {
    proc.stderr.write(message + "\n");
  } else if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(message);
  }
}

/**
 * Test-only: clear the per-process dedupe set so a fresh `beforeEach` can assert
 * "warns once" behavior in isolation.
 *
 * @internal
 */
export function _resetDeprecationWarnings(): void {
  warned.clear();
}
