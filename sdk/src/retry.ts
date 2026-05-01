/**
 * `withRetry(fn, opts?)` — exponential-backoff retry helper for SDK
 * operations. Defaults to the canonical {@link isRetryableRun402Error}
 * policy so agents don't have to enumerate "should I retry this?" themselves.
 *
 * Caller-controlled by design: the helper is policy-only. It does NOT own
 * idempotency keys. Pair with the SDK method's own `idempotencyKey`
 * option by baking it into the closure:
 *
 * @example
 *   const release = await withRetry(
 *     () => r.deploy.apply(spec, { idempotencyKey: "my-deploy-2026-05-01" }),
 *     { attempts: 3, onRetry: (e, n, ms) => console.warn(`retry ${n} in ${ms}ms`) },
 *   );
 *
 * The closure carries the same `idempotencyKey` on every retry, so the
 * gateway dedups duplicates server-side and a retried mutation does not
 * double-apply.
 */

import { isRetryableRun402Error } from "./errors.js";

export interface RetryOptions {
  /** Total attempts (1 = no retry, 2 = 1 retry, etc.). Default: 3. */
  attempts?: number;
  /** Initial delay before the first retry. Default: 250 ms. */
  baseDelayMs?: number;
  /** Cap on the per-attempt delay. Default: 5_000 ms. */
  maxDelayMs?: number;
  /**
   * Override the retry decision. Default: {@link isRetryableRun402Error}.
   * Receives the thrown error and the 1-based index of the attempt that just
   * failed; returning `true` schedules another attempt (subject to the
   * `attempts` cap), `false` re-throws immediately.
   */
  retryIf?: (error: unknown, attempt: number) => boolean;
  /**
   * Called synchronously after each retryable failure, before the delay
   * starts. Useful for logging / telemetry. `attempt` is the 1-based index
   * of the attempt that just failed; `delayMs` is the wait until the next
   * attempt. Throws inside this callback are swallowed — a buggy logger
   * cannot abort the retry chain.
   */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Run `fn` with exponential backoff, retrying retryable {@link Run402Error}
 * subclasses up to `attempts` times. After exhausting attempts (or when
 * `retryIf` returns false), throws the LAST observed error — preserving the
 * structured envelope so the caller's catch handler can branch on `kind`.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 5_000;
  const retryIf = opts.retryIf ?? defaultRetryIf;

  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt === attempts) break;
      if (!retryIf(e, attempt)) break;
      const delay = Math.min(max, base * 2 ** (attempt - 1));
      try {
        opts.onRetry?.(e, attempt, delay);
      } catch {
        /* swallow — buggy onRetry must not abort the retry chain */
      }
      await sleep(delay);
    }
  }
  throw last;
}

function defaultRetryIf(error: unknown, _attempt: number): boolean {
  return isRetryableRun402Error(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
