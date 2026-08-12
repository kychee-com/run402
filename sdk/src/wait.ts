/**
 * `waitFor` — the one poll loop (attention-architecture Wave E).
 *
 * Every wait on this platform is the same shape: fetch a fact, ask whether it
 * has reached the state you need, sleep, repeat, stop at a deadline. Before
 * this helper the shape was hand-rolled three times (escalations'
 * `raiseAndWait`, the CLI's `--wait`, room catch-up polling), and each copy
 * had to re-decide the one contract that matters:
 *
 * **Silence is an answer.** On timeout, `waitFor` RETURNS the last observed
 * state — it never throws. A thrown timeout invites `catch`-and-proceed,
 * which quietly converts "nobody answered" into consent. Returning the
 * still-unsettled state forces the caller to look at it and decide, with
 * "nothing happened" as a visible input rather than an exception it
 * swallowed. (This is the same reason an exhausted escalation rests OPEN and
 * a deploy gate must not auto-approve on timeout.)
 */

export interface WaitForOptions {
  /** Delay between polls. Clamped to ≥1s so a tight loop cannot hammer the API. */
  pollMs?: number;
  /** Total budget. When it elapses, the LAST OBSERVED state is returned. */
  timeoutMs?: number;
  /**
   * Called after each poll with the latest state — progress reporting
   * (a CLI prints to stderr here) without owning the loop.
   */
  onPoll?: (state: unknown, elapsedMs: number) => void;
}

export interface WaitForResult<T> {
  state: T;
  /** True when `predicate` accepted `state`; false means the wait timed out. */
  settled: boolean;
  elapsedMs: number;
  polls: number;
}

/**
 * Poll `fetch` until `predicate(state)` is true or the timeout elapses.
 *
 * The initial state is fetched immediately (a wait that starts already
 * settled costs one call and zero sleeps). A `fetch` rejection propagates —
 * an API failure is not silence and must not be mistaken for it.
 */
export async function waitFor<T>(
  fetchState: () => Promise<T>,
  predicate: (state: T) => boolean,
  opts: WaitForOptions = {},
): Promise<WaitForResult<T>> {
  const pollMs = Math.max(opts.pollMs ?? 30_000, 1_000);
  const timeoutMs = opts.timeoutMs ?? 60 * 60 * 1000;
  const startedAt = Date.now();

  let polls = 1;
  let state = await fetchState();
  opts.onPoll?.(state, Date.now() - startedAt);

  while (!predicate(state) && Date.now() - startedAt + pollMs <= timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    polls++;
    state = await fetchState();
    opts.onPoll?.(state, Date.now() - startedAt);
  }

  return {
    state,
    settled: predicate(state),
    elapsedMs: Date.now() - startedAt,
    polls,
  };
}
