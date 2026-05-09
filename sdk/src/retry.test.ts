/**
 * Tests for `withRetry` — backoff timing, retry decision, last-error
 * preservation, idempotency-key passthrough via closure, callback ordering.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ApiError, NetworkError, PaymentRequired, Run402DeployError } from "./errors.js";
import { withRetry } from "./retry.js";

// ─── Happy path ──────────────────────────────────────────────────────────────

describe("withRetry happy path", () => {
  it("first-attempt success returns immediately, no onRetry calls", async () => {
    let calls = 0;
    let retries = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return "ok";
      },
      { onRetry: () => retries++ },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 1);
    assert.equal(retries, 0);
  });
});

// ─── Retry on retryable failures ─────────────────────────────────────────────

describe("withRetry on retryable errors", () => {
  it("retries through 503 then succeeds, onRetry fires twice", async () => {
    let calls = 0;
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new ApiError("transient", 503, null, "polling");
        return "victory";
      },
      {
        attempts: 3,
        baseDelayMs: 1, // tiny so the test runs fast
        maxDelayMs: 1,
        onRetry: (_e, attempt, delayMs) => retries.push({ attempt, delayMs }),
      },
    );
    assert.equal(result, "victory");
    assert.equal(calls, 3);
    assert.equal(retries.length, 2);
    assert.equal(retries[0]?.attempt, 1);
    assert.equal(retries[1]?.attempt, 2);
  });

  it("retries through NetworkError", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new NetworkError("dns", new Error("ENOTFOUND"), "fetching");
        return 42;
      },
      { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    );
    assert.equal(result, 42);
    assert.equal(calls, 2);
  });
});

// ─── Non-retryable failures throw immediately ────────────────────────────────

describe("withRetry on non-retryable errors", () => {
  it("PaymentRequired is not retried by default; throws on first attempt", async () => {
    let calls = 0;
    let retries = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls++;
            throw new PaymentRequired("pay up", 402, { amount: "1" }, "deploying");
          },
          { attempts: 3, baseDelayMs: 1, onRetry: () => retries++ },
        ),
      (err: unknown) => err instanceof PaymentRequired,
    );
    assert.equal(calls, 1);
    assert.equal(retries, 0);
  });

  it("4xx (non-retryable) throws on first attempt", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls++;
            throw new ApiError("bad input", 400, null, "submitting");
          },
          { attempts: 3, baseDelayMs: 1 },
        ),
      (err: unknown) => err instanceof ApiError,
    );
    assert.equal(calls, 1);
  });

  it("Run402DeployError with safeToRetry=false throws immediately", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls++;
            throw new Run402DeployError("invalid", {
              code: "INVALID_SPEC",
              context: "validating",
            });
          },
          { attempts: 3, baseDelayMs: 1 },
        ),
      (err: unknown) => err instanceof Run402DeployError,
    );
    assert.equal(calls, 1);
  });
});

// ─── Last-error preservation ─────────────────────────────────────────────────

describe("withRetry last-error preservation", () => {
  it("when all attempts fail, throws the LAST error (not a wrapper)", async () => {
    const errs: ApiError[] = [];
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            const e = new ApiError(
              `attempt ${errs.length + 1}`,
              503,
              null,
              "polling",
            );
            errs.push(e);
            throw e;
          },
          { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
        ),
      (thrown: unknown) => {
        // Identity check — the rethrown error is the LAST one constructed,
        // with all structured fields intact.
        return thrown === errs[errs.length - 1] && thrown instanceof ApiError;
      },
    );
    assert.equal(errs.length, 3);
    // The thrown error's message should be "attempt 3", proving it's the last.
    assert.equal(errs[2]?.message, "attempt 3");
  });
});

// ─── Custom retryIf ──────────────────────────────────────────────────────────

describe("withRetry custom retryIf", () => {
  it("retryIf returning false short-circuits without firing onRetry", async () => {
    let calls = 0;
    let retries = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls++;
            throw new ApiError("a", 503, null, "c"); // would normally retry
          },
          {
            attempts: 3,
            baseDelayMs: 1,
            retryIf: () => false, // override: never retry
            onRetry: () => retries++,
          },
        ),
      (err: unknown) => err instanceof ApiError,
    );
    assert.equal(calls, 1);
    assert.equal(retries, 0);
  });

  it("custom retryIf can retry on PaymentRequired (overriding default)", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw new PaymentRequired("pay", 402, null, "c");
        return "got it";
      },
      {
        attempts: 3,
        baseDelayMs: 1,
        retryIf: (e) => e instanceof PaymentRequired,
      },
    );
    assert.equal(result, "got it");
    assert.equal(calls, 2);
  });

  it("default policy remains broader than deploy.apply safe-race retry allowlist", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) {
          throw new Run402DeployError("migration can be retried by generic helper", {
            code: "MIGRATION_FAILED",
            context: "testing retry helper",
            body: { safe_to_retry: true },
          });
        }
        return "retried";
      },
      { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    );
    assert.equal(result, "retried");
    assert.equal(calls, 2);
  });

  it("retryIf receives the 1-based attempt number", async () => {
    const seenAttempts: number[] = [];
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls++;
            throw new ApiError("a", 503, null, "c");
          },
          {
            attempts: 3,
            baseDelayMs: 1,
            retryIf: (_e, attempt) => {
              seenAttempts.push(attempt);
              return true;
            },
          },
        ),
    );
    // retryIf is invoked after each failed attempt EXCEPT the last one
    // (no point asking "should I retry?" when there are no attempts left).
    assert.deepEqual(seenAttempts, [1, 2]);
  });
});

// ─── onRetry callback ────────────────────────────────────────────────────────

describe("withRetry onRetry callback", () => {
  it("fires synchronously after each retryable failure with correct args", async () => {
    const events: Array<{ msg: string; attempt: number; delayMs: number }> = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new ApiError(`fail ${calls}`, 503, null, "c");
        return "done";
      },
      {
        attempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
        onRetry: (e, attempt, delayMs) => {
          if (e instanceof ApiError) {
            events.push({ msg: e.message, attempt, delayMs });
          }
        },
      },
    );
    assert.equal(result, "done");
    assert.equal(events.length, 2);
    assert.equal(events[0]?.msg, "fail 1");
    assert.equal(events[0]?.attempt, 1);
    assert.equal(events[1]?.msg, "fail 2");
    assert.equal(events[1]?.attempt, 2);
  });

  it("a buggy onRetry that throws does NOT abort the retry chain", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new ApiError("once", 503, null, "c");
        return "ok";
      },
      {
        attempts: 3,
        baseDelayMs: 1,
        onRetry: () => {
          throw new Error("buggy logger");
        },
      },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });
});

// ─── Backoff timing ──────────────────────────────────────────────────────────

describe("withRetry backoff timing", () => {
  it("delay doubles per attempt and is capped by maxDelayMs", async () => {
    const delays: number[] = [];
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            throw new ApiError("a", 503, null, "c");
          },
          {
            attempts: 5,
            baseDelayMs: 100,
            maxDelayMs: 250, // forces the cap to bite at attempt >= 3
            onRetry: (_e, _attempt, delayMs) => delays.push(delayMs),
          },
        ),
    );
    // Expected: 100, 200, 250, 250  (attempt 1→2: 100*1=100; 2→3: 100*2=200;
    // 3→4: 100*4=400 capped at 250; 4→5: 100*8=800 capped at 250)
    assert.deepEqual(delays, [100, 200, 250, 250]);
  });
});

// ─── Idempotency-key passthrough via closure ─────────────────────────────────

describe("withRetry idempotency-key closure passthrough", () => {
  it("the key baked into the closure carries on every retry", async () => {
    const keysSeen: string[] = [];
    const fakeApply = async (
      _spec: unknown,
      opts: { idempotencyKey: string },
    ): Promise<string> => {
      keysSeen.push(opts.idempotencyKey);
      if (keysSeen.length < 3) throw new ApiError("transient", 503, null, "applying");
      return "released";
    };

    const result = await withRetry(
      () => fakeApply({ project: "prj_x" }, { idempotencyKey: "deploy-2026-05-01" }),
      { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    );

    assert.equal(result, "released");
    assert.deepEqual(keysSeen, [
      "deploy-2026-05-01",
      "deploy-2026-05-01",
      "deploy-2026-05-01",
    ]);
  });
});
