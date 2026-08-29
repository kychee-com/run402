/**
 * gitvault-connection-amortization — the prewarm's spec-pinned guarantees:
 * one GET to <base>/health on the injected fetch, total silence on every
 * failure shape, deferred signer warmup that also swallows, and a void
 * return (nothing for a verb path to await).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prewarmGitvaultConnection, prewarmDeps } from "./gitvault-prewarm.js";

const flush = () => new Promise((r) => setImmediate(() => setImmediate(r)));

describe("prewarmGitvaultConnection", () => {
  let fetched: Array<{ url: string; hasSignal: boolean }> = [];
  let signerCalls = 0;
  let bodyCancelled = 0;

  beforeEach(async () => {
    await flush(); // drain a prior test's deferred warmup before resetting counters
    fetched = [];
    signerCalls = 0;
    bodyCancelled = 0;
    prewarmDeps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push({ url: String(input), hasSignal: Boolean(init?.signal) });
      return {
        body: {
          cancel: async () => {
            bodyCancelled += 1;
          },
        },
      } as unknown as Response;
    }) as typeof globalThis.fetch;
    prewarmDeps.warmSigner = () => {
      signerCalls += 1;
      return null;
    };
  });

  it("fires exactly one abort-bounded GET to <base>/health and cancels the body", async () => {
    prewarmGitvaultConnection("https://api.example.test");
    await flush();
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0]!.url, "https://api.example.test/health");
    assert.equal(fetched[0]!.hasSignal, true);
    assert.equal(bodyCancelled, 1);
    assert.equal(signerCalls, 1);
  });

  it("returns void immediately — nothing a caller could await", () => {
    const out = prewarmGitvaultConnection("https://api.example.test") as unknown;
    assert.equal(out, undefined);
  });

  it("a rejecting fetch is swallowed entirely", async () => {
    prewarmDeps.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;
    prewarmGitvaultConnection("https://api.example.test");
    await flush();
    assert.equal(signerCalls, 1, "signer warmup still runs when the dial fails");
  });

  it("a throwing signer warmup is swallowed entirely", async () => {
    prewarmDeps.warmSigner = () => {
      throw new Error("no allowance");
    };
    prewarmGitvaultConnection("https://api.example.test");
    await flush();
    assert.equal(fetched.length, 1, "the dial still fires when the signer throws");
  });

  it("a malformed base never throws", async () => {
    prewarmGitvaultConnection("not a url");
    await flush();
    assert.equal(fetched.length, 0);
  });
});
