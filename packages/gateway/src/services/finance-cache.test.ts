import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFinanceCache } from "./finance-cache.js";

describe("finance-cache — request coalescing", () => {
  it("invokes the underlying fetcher exactly once when N concurrent callers share a key", async () => {
    let invocations = 0;
    let resolveInner: ((v: number) => void) | null = null;
    const fetcher = () =>
      new Promise<number>((resolve) => {
        invocations++;
        resolveInner = resolve;
      });

    const cache = createFinanceCache({ ttlMs: 30_000, now: () => 0 });

    const promises = Array.from({ length: 10 }, () => cache.get("summary:30d", fetcher));

    // Let the in-flight coalescer register subscribers before resolving
    await new Promise((r) => setImmediate(r));
    assert.equal(invocations, 1, "fetcher should have been invoked exactly once");

    resolveInner!(42);
    const results = await Promise.all(promises);
    assert.deepEqual(results, Array(10).fill(42));
    assert.equal(invocations, 1, "no additional invocations after resolution");
  });

  it("different keys do not coalesce", async () => {
    let invocations = 0;
    const fetcher = async () => {
      invocations++;
      return invocations;
    };
    const cache = createFinanceCache({ ttlMs: 30_000, now: () => 0 });
    const [a, b] = await Promise.all([
      cache.get("summary:30d", fetcher),
      cache.get("summary:7d", fetcher),
    ]);
    assert.equal(invocations, 2);
    assert.notEqual(a, b);
  });
});

describe("finance-cache — TTL", () => {
  it("serves cached value within TTL without calling fetcher", async () => {
    let invocations = 0;
    const fetcher = async () => {
      invocations++;
      return "v" + invocations;
    };
    let clock = 0;
    const cache = createFinanceCache({ ttlMs: 30_000, now: () => clock });

    const first = await cache.get("k", fetcher);
    assert.equal(first, "v1");

    clock = 15_000; // within TTL
    const second = await cache.get("k", fetcher);
    assert.equal(second, "v1");
    assert.equal(invocations, 1, "fetcher not re-invoked within TTL");
  });

  it("re-fetches after TTL expiry", async () => {
    let invocations = 0;
    const fetcher = async () => {
      invocations++;
      return "v" + invocations;
    };
    let clock = 0;
    const cache = createFinanceCache({ ttlMs: 30_000, now: () => clock });

    await cache.get("k", fetcher);
    clock = 30_001; // past TTL
    const second = await cache.get("k", fetcher);
    assert.equal(second, "v2");
    assert.equal(invocations, 2);
  });

  it("ttlMs=0 disables caching — always calls fetcher", async () => {
    let invocations = 0;
    const fetcher = async () => ++invocations;
    const cache = createFinanceCache({ ttlMs: 0, now: () => 0 });

    await cache.get("k", fetcher);
    await cache.get("k", fetcher);
    await cache.get("k", fetcher);
    assert.equal(invocations, 3);
  });
});

describe("finance-cache — refresh bypass", () => {
  it("refresh=true bypasses cache and replaces the cached value for subsequent callers", async () => {
    let invocations = 0;
    const fetcher = async () => ++invocations;
    let clock = 0;
    const cache = createFinanceCache({ ttlMs: 30_000, now: () => clock });

    const a = await cache.get("k", fetcher);
    assert.equal(a, 1);

    const b = await cache.get("k", fetcher, { refresh: true });
    assert.equal(b, 2, "refresh forces re-fetch");

    clock = 10_000;
    const c = await cache.get("k", fetcher); // within TTL of the refreshed entry
    assert.equal(c, 2, "subsequent read serves the refreshed value from cache");
    assert.equal(invocations, 2);
  });
});

describe("finance-cache — error handling", () => {
  it("does not cache rejected fetches — next caller retries", async () => {
    let invocations = 0;
    const fetcher = async () => {
      invocations++;
      if (invocations === 1) throw new Error("db down");
      return "recovered";
    };
    const cache = createFinanceCache({ ttlMs: 30_000, now: () => 0 });

    await assert.rejects(() => cache.get("k", fetcher), /db down/);
    const v = await cache.get("k", fetcher);
    assert.equal(v, "recovered");
    assert.equal(invocations, 2);
  });
});
