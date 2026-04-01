import { describe, it } from "node:test";
import assert from "node:assert/strict";

// withConcurrency is not exported, so we duplicate for unit testing.
// This mirrors the exact implementation in deployments.ts.
async function withConcurrency<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  limit: number,
  retries: number,
): Promise<{ completed: number }> {
  let completed = 0;
  let i = 0;
  async function runOne(): Promise<void> {
    while (i < items.length) {
      const idx = i++;
      const item = items[idx];
      let lastErr: Error | undefined;
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          await fn(item);
          completed++;
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          if (attempt < retries - 1) {
            await new Promise(r => setTimeout(r, 10));
          }
        }
      }
      if (lastErr) {
        const wrapped = new Error(lastErr.message) as Error & { completed: number };
        wrapped.completed = completed;
        throw wrapped;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runOne());
  await Promise.all(workers);
  return { completed };
}

describe("withConcurrency", () => {
  it("processes all items successfully", async () => {
    const results: number[] = [];
    const { completed } = await withConcurrency(
      [1, 2, 3, 4, 5],
      async (n) => { results.push(n); },
      3, 2,
    );
    assert.equal(completed, 5);
    assert.deepEqual(results.sort(), [1, 2, 3, 4, 5]);
  });

  it("respects concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await withConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
      },
      5, 1,
    );
    assert.ok(maxInFlight <= 5, "Max in-flight was " + maxInFlight + ", expected <= 5");
    assert.ok(maxInFlight >= 2, "Max in-flight was " + maxInFlight + ", expected >= 2");
  });

  it("retries on transient failure", async () => {
    let attempts = 0;
    const { completed } = await withConcurrency(
      [1],
      async () => {
        attempts++;
        if (attempts === 1) throw new Error("transient");
      },
      1, 2,
    );
    assert.equal(completed, 1);
    assert.equal(attempts, 2);
  });

  it("throws after exhausting retries with completed count", async () => {
    try {
      await withConcurrency(
        [1, 2, 3],
        async (n) => {
          if (n === 2) throw new Error("permanent failure");
        },
        1, 2,
      );
      assert.fail("should have thrown");
    } catch (err: unknown) {
      const e = err as Error & { completed: number };
      assert.equal(e.message, "permanent failure");
      assert.equal(e.completed, 1);
    }
  });

  it("handles empty items array", async () => {
    const { completed } = await withConcurrency([], async () => {}, 5, 1);
    assert.equal(completed, 0);
  });

  it("handles limit larger than items", async () => {
    const results: number[] = [];
    await withConcurrency([1, 2], async (n) => { results.push(n); }, 100, 1);
    assert.equal(results.length, 2);
  });
});
