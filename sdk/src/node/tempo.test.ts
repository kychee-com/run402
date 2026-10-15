import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { TEMPO_MAINNET, TEMPO_MODERATO, requestTempoFaucet } from "./tempo.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonFetch(body: unknown, onRequest?: (input: string, init: RequestInit | undefined) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    onRequest?.(String(input), init);
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("requestTempoFaucet", () => {
  it("posts tempo_fundAddress for the address to the Moderato node and reports funded", async () => {
    let seen: { url: string; body: unknown } | null = null;
    globalThis.fetch = jsonFetch({ jsonrpc: "2.0", id: 1, result: "0xtx" }, (url, init) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
    });
    const outcome = await requestTempoFaucet("0x00000000000000000000000000000000000000a1");
    assert.deepEqual(outcome, { funded: true });
    assert.equal(seen!.url, TEMPO_MODERATO.rpcUrl);
    assert.deepEqual(seen!.body, {
      jsonrpc: "2.0",
      method: "tempo_fundAddress",
      params: ["0x00000000000000000000000000000000000000a1"],
      id: 1,
    });
  });

  it("a faucet refusal is { funded: false } carrying the node's message", async () => {
    globalThis.fetch = jsonFetch({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "rate limited" } });
    assert.deepEqual(await requestTempoFaucet("0xabc"), { funded: false, message: "rate limited" });
  });

  it("an answer with neither result nor error is a refusal with a generic message", async () => {
    globalThis.fetch = jsonFetch({});
    assert.deepEqual(await requestTempoFaucet("0xabc"), { funded: false, message: "Tempo faucet failed" });
  });

  it("refuses a mainnet without touching the network", async () => {
    globalThis.fetch = (() => {
      throw new Error("must not be called");
    }) as typeof fetch;
    const outcome = await requestTempoFaucet("0xabc", TEMPO_MAINNET);
    assert.equal(outcome.funded, false);
    assert.match((outcome as { message: string }).message, /mainnet/);
  });

  it("a network failure propagates to the caller", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(requestTempoFaucet("0xabc"), /fetch failed/);
  });
});
