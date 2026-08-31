/**
 * gitvault-connection-amortization — the prewarm's spec-pinned guarantees:
 * one GET to <base>/health on the injected fetch, total silence on every
 * failure shape, deferred signer warmup that also swallows, and a void
 * return (nothing for a verb path to await).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prewarmGitvaultConnection, kickGitvaultConnection, predialGitvaultObjectStore, prewarmDeps } from "./gitvault-prewarm.js";

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
    prewarmDeps.readObjectStoreOrigins = () => [];
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

  // gitvault-first-op-premium task 2.1 — the narrow connection-only half a
  // resident daemon's session-accept hook calls. Measured live: calling the
  // FULL prewarm (this narrow dial PLUS the deferred signer/paid-stack warm)
  // on every forwarded session re-triggered the paid-fetch buyer's rail
  // probe every session (~150-300ms wasted, two live RPC calls a gitvault
  // session never needs) — the daemon already warmed that stack once at
  // boot. `kickGitvaultConnection` must do ONLY the dial, never the deferred
  // half, so a per-session pre-connect kick cannot regress into that cost.

  it("kickGitvaultConnection fires the same one abort-bounded GET to <base>/health and cancels the body", async () => {
    kickGitvaultConnection("https://api.example.test");
    await flush();
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0]!.url, "https://api.example.test/health");
    assert.equal(fetched[0]!.hasSignal, true);
    assert.equal(bodyCancelled, 1);
  });

  it("kickGitvaultConnection never touches the signer or paid-stack warmup — that is the FULL prewarm's job, once per process, not per session", async () => {
    kickGitvaultConnection("https://api.example.test");
    await flush();
    assert.equal(signerCalls, 0, "kickGitvaultConnection must not re-warm the signer on every session");
  });

  it("kickGitvaultConnection returns void immediately", () => {
    const out = kickGitvaultConnection("https://api.example.test") as unknown;
    assert.equal(out, undefined);
  });

  it("kickGitvaultConnection swallows a rejecting fetch entirely — never a session-accept failure", async () => {
    prewarmDeps.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;
    assert.doesNotThrow(() => kickGitvaultConnection("https://api.example.test"));
    await flush();
  });

  it("kickGitvaultConnection on a malformed base never throws", async () => {
    kickGitvaultConnection("not a url");
    await flush();
    assert.equal(fetched.length, 0);
  });
});

// gitvault-object-host-predial task 2.1/3.1 — the object-store predial's
// spec-pinned guarantees are IDENTICAL to the API-origin prewarm above:
// fire-and-forget, silent on every failure, zero footprint on any counted
// budget (this module is entirely outside the request kernel already —
// these tests confirm the predial adds no NEW way in), and a repo with
// nothing persisted behaves byte-identically to before this change.
describe("predialGitvaultObjectStore", () => {
  let fetched: Array<{ url: string; hasSignal: boolean }> = [];
  let bodyCancelled = 0;

  beforeEach(async () => {
    await flush();
    fetched = [];
    bodyCancelled = 0;
    prewarmDeps.fetch = (async (input: RequestInfo | URL) => {
      fetched.push({ url: String(input), hasSignal: true });
      return {
        body: {
          cancel: async () => {
            bodyCancelled += 1;
          },
        },
      } as unknown as Response;
    }) as typeof globalThis.fetch;
  });

  it("a first-ever repo (nothing persisted) predials nothing — byte-identical to before this change", () => {
    prewarmDeps.readObjectStoreOrigins = () => [];
    predialGitvaultObjectStore("src_" + "1".repeat(32));
    assert.equal(fetched.length, 0);
  });

  it("dials every persisted origin, on the owned dispatcher, body cancelled", async () => {
    prewarmDeps.readObjectStoreOrigins = () => ["https://bucket.s3.amazonaws.com", "https://edge.run402.com"];
    predialGitvaultObjectStore("src_" + "1".repeat(32));
    await flush();
    assert.deepEqual(
      fetched.map((f) => f.url),
      ["https://bucket.s3.amazonaws.com/", "https://edge.run402.com/"],
    );
    assert.equal(bodyCancelled, 2);
  });

  it("passes repoId and keystoreRoot through to the injected lookup unchanged", () => {
    let seen: [string, string | undefined] | null = null;
    prewarmDeps.readObjectStoreOrigins = (repoId, keystoreRoot) => {
      seen = [repoId, keystoreRoot];
      return [];
    };
    predialGitvaultObjectStore("src_" + "2".repeat(32), "/tmp/some-root");
    assert.deepEqual(seen, ["src_" + "2".repeat(32), "/tmp/some-root"]);
  });

  it("returns void immediately — nothing a caller could await", () => {
    prewarmDeps.readObjectStoreOrigins = () => ["https://bucket.s3.amazonaws.com"];
    const out = predialGitvaultObjectStore("src_" + "1".repeat(32)) as unknown;
    assert.equal(out, undefined);
  });

  it("a throwing origin lookup is swallowed entirely — never surfaces from the predial", () => {
    prewarmDeps.readObjectStoreOrigins = () => {
      throw new Error("keystore read failure");
    };
    assert.doesNotThrow(() => predialGitvaultObjectStore("src_" + "1".repeat(32)));
    assert.equal(fetched.length, 0);
  });

  it("a rejecting fetch to one origin is swallowed and does not stop the others", async () => {
    let calls = 0;
    prewarmDeps.readObjectStoreOrigins = () => ["https://dead.example.com", "https://alive.example.com"];
    prewarmDeps.fetch = (async (input: RequestInfo | URL) => {
      calls += 1;
      if (String(input) === "https://dead.example.com/") throw new Error("ECONNREFUSED");
      fetched.push({ url: String(input), hasSignal: true });
      return { body: { cancel: async () => {} } } as unknown as Response;
    }) as typeof globalThis.fetch;
    predialGitvaultObjectStore("src_" + "1".repeat(32));
    await flush();
    assert.equal(calls, 2);
    assert.deepEqual(
      fetched.map((f) => f.url),
      ["https://alive.example.com/"],
    );
  });

  it("a malformed persisted origin never throws and never blocks the other origins", async () => {
    // `new URL("not a url")` throws SYNCHRONOUSLY — caught per-origin, so
    // the loop never even reaches `fetch` for it, and the well-formed
    // sibling origin still dials.
    prewarmDeps.readObjectStoreOrigins = () => ["not a url", "https://alive.example.com"];
    assert.doesNotThrow(() => predialGitvaultObjectStore("src_" + "1".repeat(32)));
    await flush();
    assert.deepEqual(
      fetched.map((f) => f.url),
      ["https://alive.example.com/"],
    );
  });

  it("every dial carries an abort signal — never holds the process open", async () => {
    let sawSignal = false;
    prewarmDeps.readObjectStoreOrigins = () => ["https://bucket.s3.amazonaws.com"];
    prewarmDeps.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sawSignal = Boolean(init?.signal);
      return { body: { cancel: async () => {} } } as unknown as Response;
    }) as typeof globalThis.fetch;
    predialGitvaultObjectStore("src_" + "1".repeat(32));
    await flush();
    assert.equal(sawSignal, true);
  });

  it("never touches sdk.stats() / the request kernel — the injected fetch is the ONLY transport surface it can reach, and it is the same non-kernel `sdkFetch` the existing prewarm already uses", async () => {
    // Structural guarantee, not a runtime one: `predialGitvaultObjectStore`
    // calls `prewarmDeps.fetch` exclusively (same as `kickGitvaultConnection`
    // above) — there is no code path here that could reach `client.request`/
    // the kernel's counted transport. This test pins that the dial count
    // equals exactly the number of persisted origins, with no extra request
    // sneaking in alongside it.
    prewarmDeps.readObjectStoreOrigins = () => ["https://a.example.com", "https://b.example.com", "https://c.example.com"];
    predialGitvaultObjectStore("src_" + "1".repeat(32));
    await flush();
    assert.equal(fetched.length, 3);
  });
});
