/**
 * `errors` namespace — the release-error-rollup query surface (gateway
 * `release-error-rollup`). The platform's durable, grouped error memory:
 * every 5xx at the invoke choke points is fingerprinted (deploy-stable by
 * normalization) and collapsed into one hot row per distinct failure, each
 * baselined against the previous ACTIVE release.
 *
 * Verdict-first, gateway-authoritative: every page leads with a computed
 * promote-vs-revert verdict, and the SDK NEVER recomputes it. No client-side
 * fingerprinting, no re-baselining, no re-counting of `new_fingerprints` — the
 * gateway's numbers are the truth. `list`/`get` pass the envelope through
 * untouched; `watch` polls and reads `verdict.new_fingerprints`.
 *
 * The promote-gate golden path (run right after an apply/promote activates a
 * release):
 *
 *   const w = await r.errors.watch(projectId, { newIn: releaseId });
 *   if (!w.clean) {
 *     // w.verdict.new_fingerprints > 0 — new error identities under the new
 *     // release. w.new_errors carries the grouped rows + fetch_logs drill-downs.
 *   }
 *
 * `clean === (verdict.new_fingerprints === 0)` — the gateway's count, never a
 * client recount. Exposed both unscoped (`r.errors.list(projectId, …)`) and
 * project-scoped (`r.project(id).errors.list(…)`), mirroring `r.events`.
 *
 * Auth: the addressed project's OWN key (apikey-authed read). A key for a
 * different project gets 403, never a 404 that would confirm existence.
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import { isRun402Error } from "../errors.js";
import { requireProjectCredentials } from "../project-credentials.js";
import type {
  ErrorsPage,
  ErrorFingerprint,
  ErrorFingerprintDetail,
  ListErrorsOptions,
  WatchErrorsOptions,
  WatchErrorsResult,
} from "./errors.types.js";

const WATCH_DEFAULT_DURATION_MS = 600_000;
const WATCH_DEFAULT_INTERVAL_MS = 15_000;
/** Consecutive tolerated-failure polls before `watch` rethrows the last error. */
const WATCH_MAX_CONSECUTIVE_FAILURES = 3;

/** Map {@link ListErrorsOptions} to the wire query string (`newIn` → `new_in`; all else 1:1). */
function errorsQuery(opts: ListErrorsOptions = {}): string {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set("since", opts.since);
  if (opts.until !== undefined) params.set("until", opts.until);
  if (opts.function !== undefined) params.set("function", opts.function);
  if (opts.kind !== undefined) params.set("kind", opts.kind);
  if (opts.fingerprint !== undefined) params.set("fingerprint", opts.fingerprint);
  if (opts.newIn !== undefined) params.set("new_in", opts.newIn);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.cursor !== undefined) params.set("cursor", opts.cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * The ONLY error classes `watch` tolerates across polls (so an outage can't
 * masquerade as a clean verdict): a network error (fetch produced no
 * response), a 408/429, or any 5xx. Everything else — a 4xx auth/validation
 * denial, a local credential miss — will not heal on retry and rethrows
 * immediately.
 */
function isTransientWatchError(err: unknown): boolean {
  if (!isRun402Error(err)) return false;
  if (err.kind === "network_error") return true;
  const s = err.status;
  return s === 408 || s === 429 || (typeof s === "number" && s >= 500);
}

/**
 * Sleep `ms`, resolving early if `signal` aborts. setTimeout-based, no busy
 * loop; the timer is always cleared and the listener always removed so no
 * handle is left dangling.
 */
function sleepRacingSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    if (signal) signal.addEventListener("abort", finish, { once: true });
  });
}

export class Errors {
  constructor(private readonly client: Client) {}

  /**
   * Read a verdict-first page of a project's grouped error fingerprints
   * (`GET /projects/v1/:project_id/errors`). Filters map 1:1 to wire query
   * params except `newIn` → `new_in`; `newIn` (a release id or `"active"`)
   * drives the verdict's promote-gate `new_fingerprints`. Envelope is passed
   * through untouched. Authorized with the addressed project's OWN key.
   */
  async list(projectId: string, opts: ListErrorsOptions = {}): Promise<ErrorsPage> {
    if (!projectId) {
      throw new LocalError("errors.list requires a projectId", "reading release error fingerprints");
    }
    const keys = await requireProjectCredentials(this.client, projectId, "reading release error fingerprints");
    return this.client.request<ErrorsPage>(
      `/projects/v1/${encodeURIComponent(projectId)}/errors${errorsQuery(opts)}`,
      {
        method: "GET",
        headers: { apikey: keys.service_key },
        withAuth: false,
        context: "reading release error fingerprints",
      },
    );
  }

  /**
   * Read one fingerprint's full detail — the same row shape as {@link list}
   * with the complete sample ring, a per-sample `fetch_logs` next action, and
   * `also_seen_in_functions` when the hash surfaced under more than one
   * function (`GET /projects/v1/:project_id/errors/:fingerprint_id`). Throws an
   * {@link ApiError} 404 (`RESOURCE_NOT_FOUND`) for an unknown id under an
   * authorized project.
   */
  async get(projectId: string, fingerprintId: string): Promise<ErrorFingerprintDetail> {
    if (!projectId) {
      throw new LocalError("errors.get requires a projectId", "reading an error fingerprint");
    }
    if (!fingerprintId) {
      throw new LocalError("errors.get requires a fingerprintId", "reading an error fingerprint");
    }
    const keys = await requireProjectCredentials(this.client, projectId, "reading an error fingerprint");
    return this.client.request<ErrorFingerprintDetail>(
      `/projects/v1/${encodeURIComponent(projectId)}/errors/${encodeURIComponent(fingerprintId)}`,
      {
        method: "GET",
        headers: { apikey: keys.service_key },
        withAuth: false,
        context: "reading an error fingerprint",
      },
    );
  }

  /**
   * The promote-gate poll loop. Run it right after an apply/promote activates a
   * release to watch that release under real traffic. Polls {@link list} with
   * `{ newIn }` immediately, then every `intervalMs`, and does one final poll
   * when the `durationMs` window elapses. With `failFast` (the default), stops
   * the moment a poll reports `verdict.new_fingerprints > 0`.
   *
   * The verdict is the gateway's — `clean === (verdict.new_fingerprints === 0)`
   * is read straight off the last observed page; nothing is recomputed here.
   * `new_errors` is that page's `errors[]` (already server-filtered to
   * first-seen-under-release when `newIn` is passed).
   *
   * Fault tolerance so an outage can't masquerade as a verdict: a 4xx (other
   * than 408/429) rethrows immediately — auth/validation won't heal; network
   * errors, 5xx, 408, and 429 are tolerated, but three CONSECUTIVE failed polls
   * rethrow the last error (a successful poll resets the counter).
   *
   * `signal` aborts cleanly: if at least one poll succeeded, returns the
   * result-so-far with `aborted: true`; if none did, throws a {@link LocalError}.
   *
   * @throws {LocalError} when `projectId` or `opts.newIn` is missing, or when
   *   aborted before any poll succeeded.
   */
  async watch(projectId: string, opts: WatchErrorsOptions): Promise<WatchErrorsResult> {
    if (!projectId) {
      throw new LocalError("errors.watch requires a projectId", "watching release errors");
    }
    if (!opts || !opts.newIn) {
      throw new LocalError(
        'errors.watch requires opts.newIn (a release id or "active")',
        "watching release errors",
      );
    }
    const durationMs = opts.durationMs ?? WATCH_DEFAULT_DURATION_MS;
    const intervalMs = opts.intervalMs ?? WATCH_DEFAULT_INTERVAL_MS;
    const failFast = opts.failFast ?? true;
    const signal = opts.signal;

    const started = Date.now();
    let polls = 0;
    let consecutiveFailures = 0;
    let lastError: unknown;
    let lastPage: ErrorsPage | undefined;
    let aborted = false;

    for (;;) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }

      // Whether THIS poll is the final one (its window budget is already spent).
      const windowElapsed = Date.now() - started >= durationMs;

      let triggered = false;
      try {
        const page = await this.list(projectId, { newIn: opts.newIn });
        consecutiveFailures = 0;
        polls += 1;
        lastPage = page;
        if (opts.onPoll) {
          try {
            opts.onPoll(page, { poll: polls, elapsedMs: Date.now() - started });
          } catch {
            // A caller's onPoll must never break the watch loop.
          }
        }
        if (failFast && page.verdict.new_fingerprints > 0) triggered = true;
      } catch (err) {
        lastError = err;
        // Won't heal (4xx auth/validation, local credential miss) → surface now.
        if (!isTransientWatchError(err)) throw err;
        consecutiveFailures += 1;
        // A sustained outage must not read as a verdict.
        if (consecutiveFailures >= WATCH_MAX_CONSECUTIVE_FAILURES) throw err;
      }

      if (triggered) break;
      if (windowElapsed) break; // this was the final poll (success or tolerated failure)

      await sleepRacingSignal(intervalMs, signal);
      if (signal?.aborted) {
        aborted = true;
        break;
      }
    }

    if (!lastPage) {
      // No poll ever succeeded.
      if (aborted) {
        throw new LocalError(
          "errors.watch was aborted before any poll succeeded",
          "watching release errors",
          { cause: lastError },
        );
      }
      // Reached only if the window elapsed with zero successful polls.
      if (lastError !== undefined) throw lastError;
      throw new LocalError("errors.watch produced no result", "watching release errors");
    }

    const newErrors: ErrorFingerprint[] = lastPage.errors;
    const result: WatchErrorsResult = {
      clean: lastPage.verdict.new_fingerprints === 0,
      verdict: lastPage.verdict,
      new_errors: newErrors,
      polls,
      elapsed_ms: Date.now() - started,
    };
    if (aborted) result.aborted = true;
    return result;
  }
}
