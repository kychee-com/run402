/**
 * The Lightning buyer against a fake seller and a fake wallet: a 402 with a
 * lightning/charge challenge is paid from the wallet and retried once with
 * the preimage credential on the identical bytes; a 402 without one falls
 * back to the x402 buyer; the budget is checked before paying; an unknown
 * outcome is resolved by lookup and never paid twice; a preimage that does
 * not hash to the challenge is refused.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  LightningPaymentError,
  RUN402_MPP_LIGHTNING_PROFILE,
  createLightningFetch,
  isLightningChargedRequest,
  readLightningChallenge,
  type LightningWalletLike,
} from "./lightning-paid-fetch.js";
import type { LightningStack } from "./_paid-stack.js";
import { NwcError } from "./nwc.js";

const PREIMAGE = "11".repeat(32);
const HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");
const URI = `nostr+walletconnect://${"2".repeat(64)}?relay=wss%3A%2F%2Frelay.example&secret=${"1".repeat(64)}`;

/** A stand-in for mppx's codecs: header ⇄ JSON, credential = base64 JSON. */
const stack: LightningStack = {
  Challenge: {
    deserialize: (value: string) => JSON.parse(value.replace(/^Payment /, "")) as { method: string; intent: string; expires?: string; request?: Record<string, unknown> },
    serialize: (challenge: unknown) => `Payment ${JSON.stringify(challenge)}`,
  },
  Credential: {
    from: (parameters: { challenge: unknown; payload: unknown }) => parameters,
    serialize: (credential: unknown) => `Payment ${Buffer.from(JSON.stringify(credential)).toString("base64")}`,
  },
};

function challengeHeader(overrides: Record<string, unknown> = {}): string {
  return stack.Challenge.serialize({
    id: "c1", method: "lightning", intent: "charge", expires: "2030-01-01T00:00:00Z",
    request: { amount: "101", currency: "sat", description: "Run402 prototype tier", methodDetails: { invoice: "lnbc1fixture", paymentHash: HASH, network: "mainnet" } },
    ...overrides,
  });
}

function wallet(overrides: Partial<LightningWalletLike> = {}): LightningWalletLike & { paid: string[] } {
  const paid: string[] = [];
  return {
    paid,
    async getBudgetSats() { return { usedSats: 0, totalSats: 10_000 }; },
    async getBalanceSats() { return 1_000; },
    async payInvoice(bolt11) { paid.push(bolt11); return { preimage: PREIMAGE }; },
    async lookupInvoice() { return null; },
    ...overrides,
  };
}

interface Call { url: string; headers: Headers; body: unknown }

function seller(replies: Array<(call: Call) => Response>): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call = { url: String(input), headers: new Headers(init?.headers ?? {}), body: init?.body };
    calls.push(call);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return reply(call);
  };
  return { fetch, calls };
}

describe("createLightningFetch", () => {
  it("selects the profile, pays the Lightning challenge, and retries the identical bytes with the credential", async () => {
    const paid402 = new Response("{}", { status: 402, headers: { "www-authenticate": challengeHeader() } });
    const ok = new Response(JSON.stringify({ image: "AAA=" }), { status: 200 });
    const s = seller([() => paid402, () => ok]);
    const w = wallet();
    const fetch = createLightningFetch({ pairingUri: URI, baseFetch: s.fetch, wallet: w, stack: async () => stack, fallback: async () => { throw new Error("no fallback expected"); } });
    const response = await fetch("https://api.example/generate-image/v1", { method: "POST", body: "{\"prompt\":\"a fox\"}", headers: { "content-type": "application/json" } });
    assert.equal(response.status, 200);
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[0]!.headers.get("run402-payment-profile"), RUN402_MPP_LIGHTNING_PROFILE);
    assert.match(s.calls[0]!.headers.get("accept-payment") ?? "", /^lightning\/charge;profile=/);
    const key = s.calls[0]!.headers.get("idempotency-key");
    assert.match(key ?? "", /^lnc_/);
    assert.equal(s.calls[1]!.headers.get("idempotency-key"), key, "the retry reuses the idempotency key");
    assert.equal(s.calls[1]!.body, s.calls[0]!.body, "the retry sends the identical body");
    const credential = s.calls[1]!.headers.get("authorization") ?? "";
    assert.match(credential, /^Payment /);
    const decoded = JSON.parse(Buffer.from(credential.slice("Payment ".length), "base64").toString("utf8")) as { payload: { preimage: string } };
    assert.equal(decoded.payload.preimage, PREIMAGE);
    assert.deepEqual(w.paid, ["lnbc1fixture"]);
  });

  it("keeps a caller-supplied Idempotency-Key", async () => {
    const s = seller([() => new Response("{}", { status: 402, headers: { "www-authenticate": challengeHeader() } }), () => new Response("{}", { status: 200 })]);
    const fetch = createLightningFetch({ pairingUri: URI, baseFetch: s.fetch, wallet: wallet(), stack: async () => stack, fallback: async () => null });
    await fetch("https://api.example/tiers/v1/prototype", { method: "POST", headers: { "idempotency-key": "mine-1" } });
    assert.equal(s.calls[0]!.headers.get("idempotency-key"), "mine-1");
    assert.equal(s.calls[1]!.headers.get("idempotency-key"), "mine-1");
  });

  it("falls back to the x402 buyer when the 402 carries no Lightning challenge", async () => {
    const s = seller([() => new Response("{}", { status: 402, headers: { "www-authenticate": "X402 something" } })]);
    const fallbackCalls: string[] = [];
    const fetch = createLightningFetch({
      pairingUri: URI, baseFetch: s.fetch, wallet: wallet(), stack: async () => stack,
      fallback: async () => async (input) => { fallbackCalls.push(String(input)); return new Response("x402", { status: 200 }); },
    });
    const response = await fetch("https://api.example/tiers/v1/prototype", { method: "POST" });
    assert.equal(await response.text(), "x402");
    assert.deepEqual(fallbackCalls, ["https://api.example/tiers/v1/prototype"]);
  });

  it("returns the 402 unchanged when there is no Lightning challenge and no fallback", async () => {
    const s = seller([() => new Response("{\"code\":\"PAYMENT_REQUIRED\"}", { status: 402 })]);
    const fetch = createLightningFetch({ pairingUri: URI, baseFetch: s.fetch, wallet: wallet(), stack: async () => stack, fallback: async () => null });
    const response = await fetch("https://api.example/tiers/v1/prototype", { method: "POST" });
    assert.equal(response.status, 402);
  });

  it("refuses to pay past the remaining budget or the debit cap", async () => {
    const s = seller([() => new Response("{}", { status: 402, headers: { "www-authenticate": challengeHeader() } })]);
    const w = wallet({ async getBudgetSats() { return { usedSats: 9_950, totalSats: 10_000 }; } });
    const fetch = createLightningFetch({ pairingUri: URI, baseFetch: s.fetch, wallet: w, stack: async () => stack, fallback: async () => null });
    await assert.rejects(() => fetch("https://api.example/tiers/v1/prototype", { method: "POST" }), (error: unknown) => {
      assert.ok(error instanceof LightningPaymentError);
      assert.equal(error.code, "LIGHTNING_BUDGET_EXHAUSTED");
      return true;
    });
    assert.equal(w.paid.length, 0);
    const big = seller([() => new Response("{}", { status: 402, headers: { "www-authenticate": challengeHeader({ request: { amount: "300000", currency: "sat", methodDetails: { invoice: "lnbc1big", paymentHash: HASH, network: "mainnet" } } }) } })]);
    await assert.rejects(() => createLightningFetch({ pairingUri: URI, baseFetch: big.fetch, wallet: wallet(), stack: async () => stack, fallback: async () => null })("https://api.example/tiers/v1/hobby", { method: "POST" }), /LIGHTNING_DEBIT_ABOVE_CAP|exceeds/);
  });

  it("resolves an unknown outcome by lookup and never pays the same invoice twice", async () => {
    const s = seller([() => new Response("{}", { status: 402, headers: { "www-authenticate": challengeHeader() } }), () => new Response("{}", { status: 200 })]);
    let payCalls = 0;
    const w = wallet({
      async payInvoice() { payCalls += 1; throw new NwcError("TIMEOUT", "no reply"); },
      async lookupInvoice(hash) { return hash === HASH ? { state: "settled", preimage: PREIMAGE } : null; },
    });
    const fetch = createLightningFetch({ pairingUri: URI, baseFetch: s.fetch, wallet: w, stack: async () => stack, fallback: async () => null });
    const response = await fetch("https://api.example/tiers/v1/prototype", { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal(payCalls, 1);
    assert.match(s.calls[1]!.headers.get("authorization") ?? "", /^Payment /);
  });

  it("refuses a preimage that does not hash to the challenge", async () => {
    const s = seller([() => new Response("{}", { status: 402, headers: { "www-authenticate": challengeHeader() } })]);
    const w = wallet({ async payInvoice() { return { preimage: "22".repeat(32) }; } });
    const fetch = createLightningFetch({ pairingUri: URI, baseFetch: s.fetch, wallet: w, stack: async () => stack, fallback: async () => null });
    await assert.rejects(() => fetch("https://api.example/tiers/v1/prototype", { method: "POST" }), /LIGHTNING_PREIMAGE_MISMATCH|does not hash/);
    assert.equal(s.calls.length, 1, "no retry without a matching preimage");
  });

  it("reads only lightning/charge challenges", () => {
    const tempo = new Response("", { status: 402, headers: { "www-authenticate": challengeHeader({ method: "tempo" }) } });
    assert.equal(readLightningChallenge(tempo, stack), null);
    const ok = new Response("", { status: 402, headers: { "www-authenticate": challengeHeader() } });
    assert.equal(readLightningChallenge(ok, stack)?.amountSats, 101);
  });
});

describe("createLightningFetch — request selection", () => {
  it("leaves every request that is not a charged POST untouched, with no Lightning headers and no idempotency key", async () => {
    const s = seller([() => new Response("{\"message_id\":\"msg_1\"}", { status: 201 })]);
    const w = wallet();
    const fetch = createLightningFetch({ pairingUri: URI, baseFetch: s.fetch, wallet: w, stack: async () => stack, fallback: async () => null });
    const response = await fetch("https://api.example/rooms/v1/messages", { method: "POST", body: "{\"body\":\"hi\"}", headers: { "content-type": "application/json" } });
    assert.equal(response.status, 201);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0]!.headers.get("idempotency-key"), null);
    assert.equal(s.calls[0]!.headers.get("run402-payment-profile"), null);
    assert.equal(s.calls[0]!.headers.get("accept-payment"), null);
    const get = await fetch("https://api.example/tiers/v1/status", { method: "GET" });
    assert.equal(get.status, 201);
    assert.equal(s.calls[1]!.headers.get("idempotency-key"), null);
    assert.equal(w.paid.length, 0);
  });

  it("hands a non-charged request to the x402 buyer when one exists", async () => {
    const fallbackCalls: string[] = [];
    const fetch = createLightningFetch({
      pairingUri: URI, baseFetch: async () => { throw new Error("base fetch must not be used"); }, wallet: wallet(), stack: async () => stack,
      fallback: async () => async (input) => { fallbackCalls.push(String(input)); return new Response("ok", { status: 200 }); },
    });
    await fetch("https://api.example/contracts/v1/call", { method: "POST" });
    assert.deepEqual(fallbackCalls, ["https://api.example/contracts/v1/call"]);
  });

  it("classifies charged surfaces", () => {
    assert.equal(isLightningChargedRequest("https://api.example/tiers/v1/prototype", { method: "POST" }), true);
    assert.equal(isLightningChargedRequest("https://api.example/generate-image/v1", { method: "post" }), true);
    assert.equal(isLightningChargedRequest("https://api.example/tiers/v1/status", { method: "GET" }), false);
    assert.equal(isLightningChargedRequest("https://api.example/tiers/v1/prototype/extra", { method: "POST" }), false);
    assert.equal(isLightningChargedRequest("not a url", { method: "POST" }), false);
  });
});
