/**
 * Request/response types for the `errors` namespace — the release-error-rollup
 * query surface (`GET /projects/v1/:project_id/errors` and
 * `GET /projects/v1/:project_id/errors/:fingerprint_id`).
 *
 * The platform keeps a durable, grouped error memory: every 5xx at the
 * gateway's invoke choke points is fingerprinted (normalization-first, so the
 * identity is deploy-stable) and collapsed into one hot row per distinct
 * failure. The read is **verdict-first**: the page leads with a computed
 * promote-vs-revert verdict for the release you name, then the grouped rows.
 *
 * The verdict math is the GATEWAY'S — never recomputed client-side. The SDK
 * never fingerprints, never re-baselines, never re-counts `new_fingerprints`.
 * It passes the envelope through untouched (index signatures keep unknown
 * future fields), and `watch` polls this surface and reads
 * `verdict.new_fingerprints` as the truth.
 *
 * Baseline semantics: `baseline_release_id` is the previous ACTIVE release by
 * ACTIVATION HISTORY (`releases.activated_at`, re-stamped on every activation),
 * NOT lineage — so after A→B→(rollback)→A→C, C's baseline is A and fingerprints
 * first seen under B are not misattributed to C. Cursors are OPAQUE keyset
 * tokens: store `next_cursor` and pass it back as `{ cursor }`, never parse it.
 */

/** The choke point that produced an error identity. */
export type ErrorKind = "uncaught" | "boot_crash" | "invoke_failed" | "handled_5xx";

/**
 * How much signal a fingerprint's identity carries.
 * - `frame_names` — full fidelity: ≥1 stable stack frame name survived.
 * - `message_only` — normalized message template, no stable frames.
 * - `coarse` — no error detail at all (the function predates the error
 *   side-channel). Redeploying the function upgrades FUTURE occurrences to
 *   full fidelity; already-recorded coarse rows stay coarse.
 */
export type FingerprintQuality = "frame_names" | "message_only" | "coarse";

/**
 * A platform-synthesized drill-down attached to a fingerprint. Today the only
 * type is `fetch_logs`, carrying the exact `run402 logs <fn> --request-id
 * <sample_id>` command for a sample occurrence. Rendering an action must never
 * execute it. Unknown future fields pass through via the index signature.
 */
export interface ErrorNextAction {
  type: string;
  command?: string;
  why?: string;
  [key: string]: unknown;
}

/**
 * One occurrence pointer. The `id` is a fetchable request/run id
 * (`req_…` / `fnrun_…` / `fnatt_…`) accepted by the function-diagnostics logs
 * surface; `release_id` is the release the occurrence was attributed to (null
 * when the platform had no release context at ingest).
 */
export interface ErrorSample {
  id: string;
  at: string;
  release_id: string | null;
  [key: string]: unknown;
}

/**
 * The sample set for a fingerprint. `first` is the pinned first occurrence
 * (diagnostic gold — never overwritten); `recent` is a newest-first ring
 * capped at 10. The list view carries this trimmed set; {@link Errors.get}
 * returns the full ring.
 */
export interface ErrorSamples {
  first: ErrorSample;
  recent: ErrorSample[];
  [key: string]: unknown;
}

/** One grouped error identity — a hot row that collapses an error storm. */
export interface ErrorFingerprint {
  /** Stable identity hash (`fp_…`). Also the `fingerprint` filter/param value. */
  fingerprint_id: string;
  /** The function the error surfaced in. */
  function: string;
  kind: ErrorKind;
  fingerprint_quality: FingerprintQuality;
  /** Error class/type name (a JS builtin kept verbatim, else `CustomError`, or the Lambda errorType). */
  error_name: string;
  /** Normalized, low-cardinality message template (high-cardinality tokens scrubbed). */
  message_template: string;
  /** Up to 3 stable stack frame NAMES — never line/column, wrapper, or minified frames. */
  stable_frames: string[];
  /** Total occurrences collapsed into this row. */
  count: number;
  first_seen: string;
  last_seen: string;
  first_seen_release_id: string | null;
  last_seen_release_id: string | null;
  samples: ErrorSamples;
  next_actions: ErrorNextAction[];
  [key: string]: unknown;
}

/**
 * The detail row from {@link Errors.get}: the same shape as a list row with the
 * FULL sample ring, a per-sample `fetch_logs` next action, and — when the same
 * fingerprint hash surfaced under more than one function — the sibling function
 * names in `also_seen_in_functions`.
 */
export interface ErrorFingerprintDetail extends ErrorFingerprint {
  also_seen_in_functions?: string[];
}

/** The window the verdict + listing were computed over (resolved gateway-side). */
export interface ErrorsWindow {
  since: string;
  until: string;
  [key: string]: unknown;
}

/** Fingerprint-quality coverage across the project's functions. */
export interface ErrorsCoverage {
  /** Functions emitting the full-fidelity error side-channel. */
  full_fidelity_functions: number;
  /** Functions still fingerprinting coarsely (redeploy to upgrade). */
  coarse_functions: number;
  [key: string]: unknown;
}

/** Row-cap disclosure so at-cap eviction is never silent. */
export interface ErrorsRowCap {
  limit: number;
  at_cap: boolean;
  [key: string]: unknown;
}

/**
 * The computed promote-vs-revert verdict — the head of every errors page.
 *
 * With a `new_in` release, `new_fingerprints` counts error IDENTITIES first
 * seen UNDER that release (the promote-gate signal); without one it counts
 * identities first seen within the window. `invocations_in_window` pairs the
 * counts with real traffic so "0 errors over 0 traffic" is distinguishable
 * from a healthy release. Every number here is the gateway's — the SDK never
 * recomputes them.
 */
export interface ErrorsVerdict {
  window: ErrorsWindow;
  /** The `new_in` release (the resolved id when `new_in="active"`); null when no `new_in` was given. */
  compared_release_id: string | null;
  /** Previous ACTIVE release by activation history (rollback-safe); null when none / no `new_in`. */
  baseline_release_id: string | null;
  new_fingerprints: number;
  recurring_fingerprints: number;
  invocations_in_window: number;
  coverage: ErrorsCoverage;
  row_cap: ErrorsRowCap;
  [key: string]: unknown;
}

/** One page of grouped errors, verdict-first. */
export interface ErrorsPage {
  verdict: ErrorsVerdict;
  errors: ErrorFingerprint[];
  has_more: boolean;
  /** Opaque keyset cursor for the next page. Present only when `has_more`. */
  next_cursor?: string;
  [key: string]: unknown;
}

/** Options for {@link Errors.list}. All filters map 1:1 to wire query params except `newIn` → `new_in`. */
export interface ListErrorsOptions {
  /** ISO-8601 window start. Default (gateway-side): `until` − 24h. */
  since?: string;
  /** ISO-8601 window end. Default (gateway-side): now. */
  until?: string;
  /** Restrict to one function by name. */
  function?: string;
  /** Restrict to one choke-point class. */
  kind?: ErrorKind;
  /** Restrict to one fingerprint identity (`fp_…`). */
  fingerprint?: string;
  /**
   * A release id, or the literal `"active"` (resolves to the live release
   * gateway-side). Selects rows first seen UNDER that release and drives the
   * verdict's `new_fingerprints` / baseline. Wire param: `new_in`.
   */
  newIn?: string;
  /** Page size (server default 50, max 200). */
  limit?: number;
  /** Opaque keyset cursor from a prior page's `next_cursor`. */
  cursor?: string;
}

/**
 * Options for {@link Errors.watch} — the promote-gate poll loop. `newIn` is
 * REQUIRED (the release under scrutiny). The loop polls immediately, then every
 * `intervalMs`, and does one final poll when the window elapses.
 */
export interface WatchErrorsOptions {
  /** The release to watch — a release id, or `"active"`. Required. */
  newIn: string;
  /** Total watch window in ms before returning the last verdict. Default 600_000 (10 min). */
  durationMs?: number;
  /** Poll cadence in ms. NOT clamped by the SDK (callers/tests may go fast). Default 15_000. */
  intervalMs?: number;
  /** Abort the watch cleanly. If ≥1 poll succeeded, returns the result-so-far with `aborted: true`. */
  signal?: AbortSignal;
  /** Called after each SUCCESSFUL poll with the page and progress metadata. Throwing from it never breaks the loop. */
  onPoll?: (page: ErrorsPage, meta: { poll: number; elapsedMs: number }) => void;
  /** Stop the moment a poll reports `verdict.new_fingerprints > 0`. Default true. */
  failFast?: boolean;
}

/**
 * Result of {@link Errors.watch}. `clean` is `verdict.new_fingerprints === 0`
 * on the last observed page — the gateway's number, never a client recount.
 * `new_errors` is the `errors[]` of the final/triggering page (already
 * server-filtered to first-seen-under-release when `newIn` was passed).
 */
export interface WatchErrorsResult {
  /** True iff the last verdict reported zero new fingerprints. The promote-gate pass/fail. */
  clean: boolean;
  /** The last verdict observed (final poll, or the fail-fast triggering poll). */
  verdict: ErrorsVerdict;
  /** The grouped errors from the final/triggering page. */
  new_errors: ErrorFingerprint[];
  /** Number of successful polls performed. */
  polls: number;
  /** Wall-clock ms the watch ran. */
  elapsed_ms: number;
  /** Present and true only when the watch ended because its `signal` aborted. */
  aborted?: boolean;
}
