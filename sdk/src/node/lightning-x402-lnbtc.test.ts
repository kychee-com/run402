/**
 * The Lightning rail's x402 buyer (spec `x402-lightning-exact`). The pay path
 * runs against the x402 shared vectors' client base case — a real, signed
 * request-bound invoice — with the clock pinned to its validation time.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { LNBTC_MAINNET, LNBTC_TESTNET, createLightningFetch, createLightningPayExecutor, LightningPaymentError, RUN402_MPP_LIGHTNING_PROFILE, type LightningWalletLike } from "./lightning-paid-fetch.js";
import {
  explicitRequestHeaders,
  isX402LightningCandidate,
  payX402Lightning,
  readX402LightningOffer,
  type X402LnbtcOffer,
} from "./lightning-x402-lnbtc.js";
import type { LightningStack } from "./_paid-stack.js";

interface ClientBase {
  intended_request: { http: { method: string; url: string } };
  payment_required: X402LnbtcOffer["paymentRequired"];
  payer_result: { invoice: string; payment_hash: string; preimage: string };
}

const VECTORS = JSON.parse(readFileSync(new URL("./vendor/x402-lnbtc/exact_lnbtc.vectors.json", import.meta.url), "utf8")) as {
  client: { base: ClientBase };
};
const BASE = VECTORS.client.base;
const NOW = 1_700_000_000;
const URI = `nostr+walletconnect://${"2".repeat(64)}?relay=wss%3A%2F%2Frelay.example&secret=${"1".repeat(64)}`;

function challengeResponse(paymentRequired: unknown = BASE.payment_required): Response {
  return new Response("{}", {
    status: 402,
    headers: { "payment-required": Buffer.from(JSON.stringify(paymentRequired)).toString("base64"), "content-type": "application/json" },
  });
}

function wallet(overrides: Partial<LightningWalletLike> = {}): LightningWalletLike & { paid: string[] } {
  const paid: string[] = [];
  return {
    paid,
    async getBudgetSats() { return { usedSats: 0, totalSats: 10_000 }; },
    async getBalanceSats() { return 1_000; },
    async payInvoice(bolt11) { paid.push(bolt11); return { preimage: BASE.payer_result.preimage }; },
    async lookupInvoice() { return null; },
    ...overrides,
  };
}

interface Call { url: string; headers: Headers; body: unknown }

function seller(replies: Array<() => Response>): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers ?? {}), body: init?.body });
    return replies[Math.min(calls.length - 1, replies.length - 1)]!();
  };
  return { fetch, calls };
}

const fail = (code: string, message: string, details?: Record<string, unknown>) => new LightningPaymentError(code, message, details);
const noCaps = async () => {};

describe("x402 lnbtc offer parsing", () => {
  it("finds the exact lnbtc entry with an invoice in an x402 v2 challenge", () => {
    const offer = readX402LightningOffer(challengeResponse());
    assert.equal(offer?.requirements.network, "lnbtc:000000000019d6689c085ae165831e93");
    assert.equal(offer?.requirements.extra.invoice, BASE.payer_result.invoice);
  });

  it("ignores a challenge with no lnbtc entry, an lnbtc entry without an invoice, or no x402 header", () => {
    const usdcOnly = { ...BASE.payment_required, accepts: [{ ...BASE.payment_required.accepts[0]!, network: "eip155:8453" }] };
    assert.equal(readX402LightningOffer(challengeResponse(usdcOnly)), null);
    const noInvoice = { ...BASE.payment_required, accepts: [{ ...BASE.payment_required.accepts[0]!, extra: { paymentFlow: "upfront" } }] };
    assert.equal(readX402LightningOffer(challengeResponse(noInvoice)), null);
    assert.equal(readX402LightningOffer(new Response("{}", { status: 402 })), null);
    assert.equal(readX402LightningOffer(new Response("{}", { status: 200 })), null);
  });

  it("makes a string body's content type explicit, so the bound value is the sent value", () => {
    assert.equal(explicitRequestHeaders({ body: "x" }).get("content-type"), "text/plain;charset=UTF-8");
    assert.equal(explicitRequestHeaders({ body: "x", headers: { "content-type": "application/json" } }).get("content-type"), "application/json");
    assert.equal(explicitRequestHeaders({}).get("content-type"), null);
  });

  it("probes only POSTs to Run402 surfaces that offer it", () => {
    assert.equal(isX402LightningCandidate("https://api.run402.com/generate-image/v1", { method: "POST" }), true);
    assert.equal(isX402LightningCandidate("https://api.run402.com/generate-image/v1", { method: "GET" }), false);
    assert.equal(isX402LightningCandidate("https://api.run402.com/tiers/v1/hobby", { method: "POST" }), false);
  });
});

describe("payX402Lightning", () => {
  const { method, url } = BASE.intended_request.http;

  it("pays the request-bound invoice and retries with the preimage in PAYMENT-SIGNATURE", async () => {
    const s = seller([() => new Response(JSON.stringify({ ok: true }), { status: 200 })]);
    const w = wallet();
    const paidHashes: string[] = [];
    const response = await payX402Lightning({
      input: url, init: { method }, offer: readX402LightningOffer(challengeResponse())!, wallet: w,
      baseFetch: s.fetch, fail, checkCaps: noCaps, onPaid: (hash) => paidHashes.push(hash), clock: () => NOW,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(w.paid, [BASE.payer_result.invoice]);
    assert.deepEqual(paidHashes, [BASE.payer_result.payment_hash]);
    const signature = JSON.parse(Buffer.from(s.calls[0]!.headers.get("payment-signature")!, "base64").toString("utf8")) as {
      x402Version: number; accepted: { network: string; extra: { invoice: string } }; payload: { preimage: string };
    };
    assert.equal(signature.x402Version, 2);
    assert.equal(signature.payload.preimage, BASE.payer_result.preimage);
    assert.equal(signature.accepted.extra.invoice, BASE.payer_result.invoice);
  });

  it("refuses, without paying, an invoice bound to a different request", async () => {
    const w = wallet();
    await assert.rejects(
      () => payX402Lightning({
        input: url, init: { method: "POST", body: "{\"prompt\":\"something else\"}" }, offer: readX402LightningOffer(challengeResponse())!,
        wallet: w, baseFetch: async () => { throw new Error("must not retry"); }, fail, checkCaps: noCaps, clock: () => NOW,
      }),
      (error: unknown) => error instanceof LightningPaymentError && error.code === "LIGHTNING_REQUEST_BINDING_MISMATCH",
    );
    assert.deepEqual(w.paid, []);
  });

  it("refuses, without paying, when the cap check refuses", async () => {
    const w = wallet();
    await assert.rejects(
      () => payX402Lightning({
        input: url, init: { method }, offer: readX402LightningOffer(challengeResponse())!, wallet: w,
        baseFetch: async () => { throw new Error("must not retry"); }, fail,
        checkCaps: async (sats) => { throw fail("LIGHTNING_DEBIT_ABOVE_CAP", `${sats} sats is too much`); }, clock: () => NOW,
      }),
      (error: unknown) => error instanceof LightningPaymentError && error.code === "LIGHTNING_DEBIT_ABOVE_CAP",
    );
    assert.deepEqual(w.paid, []);
  });

  it("refuses an expired invoice before paying", async () => {
    const w = wallet();
    await assert.rejects(
      () => payX402Lightning({
        input: url, init: { method }, offer: readX402LightningOffer(challengeResponse())!, wallet: w,
        baseFetch: async () => { throw new Error("must not retry"); }, fail, checkCaps: noCaps, clock: () => NOW + 10_000,
      }),
      (error: unknown) => error instanceof LightningPaymentError && error.code === "LIGHTNING_X402_INVOICE_REFUSED",
    );
    assert.deepEqual(w.paid, []);
  });
});

describe("createLightningFetch on the image route", () => {
  const stack = {
    Challenge: { deserialize: (value: string) => JSON.parse(value.replace(/^Payment /, "")), serialize: (c: unknown) => `Payment ${JSON.stringify(c)}` },
    Credential: { from: (p: unknown) => p, serialize: (c: unknown) => `Payment ${Buffer.from(JSON.stringify(c)).toString("base64")}` },
  } as unknown as LightningStack;
  const IMAGE = "https://api.run402.com/generate-image/v1";
  const BODY = "{\"prompt\":\"a fox\"}";

  it("prefers x402 lnbtc: probes without the MPP profile and pays the offer (refusing one bound elsewhere)", async () => {
    // The vector's invoice is bound to another request, so the buyer refuses
    // it before paying — which proves it took the x402 lnbtc path.
    const s = seller([() => challengeResponse()]);
    const w = wallet();
    const fetch = createLightningFetch({ pairingUri: URI, baseFetch: s.fetch, wallet: w, stack: async () => stack, fallback: async () => null, clock: () => NOW });
    await assert.rejects(
      () => fetch(IMAGE, { method: "POST", body: BODY, headers: { "content-type": "application/json" } }),
      (error: unknown) => error instanceof LightningPaymentError && error.code === "LIGHTNING_REQUEST_BINDING_MISMATCH",
    );
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0]!.headers.get("run402-payment-profile"), null, "the probe reaches the x402 paywall, not MPP");
    assert.deepEqual(w.paid, []);
  });

  it("falls through to MPP Lightning when the probe's 402 has no lnbtc entry", async () => {
    const mpp402 = () => new Response("{}", { status: 402, headers: { "www-authenticate": `Payment ${JSON.stringify({
      id: "c1", method: "lightning", intent: "charge", expires: "2030-01-01T00:00:00Z",
      request: { amount: "50", currency: "sat", methodDetails: { invoice: "lnbc1fixture", paymentHash: BASE.payer_result.payment_hash, network: "mainnet" } },
    })}` } });
    const usdcOnly = { ...BASE.payment_required, accepts: [{ ...BASE.payment_required.accepts[0]!, network: "eip155:8453" }] };
    const s = seller([() => challengeResponse(usdcOnly), mpp402, () => new Response("{}", { status: 200 })]);
    const w = wallet();
    const fetch = createLightningFetch({ pairingUri: URI, baseFetch: s.fetch, wallet: w, stack: async () => stack, fallback: async () => null });
    const response = await fetch(IMAGE, { method: "POST", body: BODY, headers: { "content-type": "application/json" } });
    assert.equal(response.status, 200);
    assert.equal(s.calls.length, 3);
    assert.equal(s.calls[1]!.headers.get("run402-payment-profile"), RUN402_MPP_LIGHTNING_PROFILE);
    assert.deepEqual(w.paid, ["lnbc1fixture"]);
  });

  it("returns a non-402 probe as-is (nothing owed)", async () => {
    const s = seller([() => new Response("{\"image\":\"AAA=\"}", { status: 200 })]);
    const w = wallet();
    const fetch = createLightningFetch({ pairingUri: URI, baseFetch: s.fetch, wallet: w, stack: async () => stack, fallback: async () => null });
    const response = await fetch(IMAGE, { method: "POST", body: BODY });
    assert.equal(response.status, 200);
    assert.equal(s.calls.length, 1);
    assert.deepEqual(w.paid, []);
  });
});

describe("createLightningFetch on any URL (lightning-buyer-any-route)", () => {
  const stack = {
    Challenge: { deserialize: (value: string) => JSON.parse(value.replace(/^Payment /, "")), serialize: (c: unknown) => `Payment ${JSON.stringify(c)}` },
    Credential: { from: (p: unknown) => p, serialize: (c: unknown) => `Payment ${Buffer.from(JSON.stringify(c)).toString("base64")}` },
  } as unknown as LightningStack;
  const { method, url } = BASE.intended_request.http;
  const paidResponse = () => new Response("{\"ok\":true}", {
    status: 200,
    headers: { "payment-response": Buffer.from(JSON.stringify({ success: true, transaction: BASE.payer_result.payment_hash, network: LNBTC_MAINNET })).toString("base64") },
  });
  const testnetChallenge = { ...BASE.payment_required, accepts: [{ ...BASE.payment_required.accepts[0]!, network: LNBTC_TESTNET }] };

  it("pays the lnbtc entry of a 402 on a URL that is not a Run402 surface", async () => {
    const s = seller([() => challengeResponse(), paidResponse]);
    const w = wallet();
    const paid: string[] = [];
    const fetch = createLightningFetch({ pairingUri: URI, baseFetch: s.fetch, wallet: w, stack: async () => stack, fallback: async () => null, clock: () => NOW, onPaid: (hash) => paid.push(hash) });
    const response = await fetch(url, { method });
    assert.equal(response.status, 200);
    assert.deepEqual(w.paid, [BASE.payer_result.invoice]);
    assert.deepEqual(paid, [BASE.payer_result.payment_hash]);
    assert.equal(s.calls.length, 2);
    assert.ok(s.calls[1]!.headers.get("payment-signature"), "the paid retry carries the proof");
  });

  it("refuses, by name and without paying, an lnbtc entry on another network than the wallet's", async () => {
    const s = seller([() => challengeResponse(testnetChallenge)]);
    const w = wallet();
    const fetch = createLightningFetch({ pairingUri: URI, baseFetch: s.fetch, wallet: w, stack: async () => stack, fallback: async () => { throw new Error("must not fall through"); }, clock: () => NOW });
    await assert.rejects(
      () => fetch(url, { method }),
      (error: unknown) => error instanceof LightningPaymentError && error.code === "LIGHTNING_NETWORK_MISMATCH" &&
        JSON.stringify(error.details.offered_networks) === JSON.stringify([LNBTC_TESTNET]) && error.details.wallet_network === LNBTC_MAINNET &&
        String(error.details.next_action).includes("--lightning-pairing"),
    );
    assert.deepEqual(w.paid, []);
    assert.equal(s.calls.length, 1);
  });

  it("probes a bring-your-own pairing's network once and judges the 402 by it", async () => {
    let probes = 0;
    const testnetWallet = wallet({ async getInfo() { probes += 1; return { network: "testnet", pubkey: null, methods: ["pay_invoice"] }; } });
    const s = seller([() => challengeResponse()]);
    const fetch = createLightningFetch({ pairingUri: URI, baseFetch: s.fetch, wallet: testnetWallet, stack: async () => stack, fallback: async () => null, walletNetwork: "probe", clock: () => NOW });
    await assert.rejects(
      () => fetch(url, { method }),
      (error: unknown) => error instanceof LightningPaymentError && error.code === "LIGHTNING_NETWORK_MISMATCH" && error.details.wallet_network === LNBTC_TESTNET,
    );
    await assert.rejects(() => fetch(url, { method }), (error: unknown) => error instanceof LightningPaymentError && error.code === "LIGHTNING_NETWORK_MISMATCH");
    assert.equal(probes, 1, "the node is asked once per buyer");
    assert.deepEqual(testnetWallet.paid, []);
  });

  it("applies a per-call sats cap before paying", async () => {
    const s = seller([() => challengeResponse()]);
    const w = wallet();
    const fetch = createLightningFetch({ pairingUri: URI, baseFetch: s.fetch, wallet: w, stack: async () => stack, fallback: async () => null, clock: () => NOW, perCall: () => ({ maxSats: 10 }) });
    await assert.rejects(
      () => fetch(url, { method }),
      (error: unknown) => error instanceof LightningPaymentError && error.code === "LIGHTNING_DEBIT_ABOVE_CAP" && error.details.cap_source === "max_sats" && error.details.cap_sats === 10,
    );
    assert.deepEqual(w.paid, []);
  });

  it("refuses a Lightning entry when a merchant receipt was demanded", async () => {
    const s = seller([() => challengeResponse()]);
    const w = wallet();
    const fetch = createLightningFetch({ pairingUri: URI, baseFetch: s.fetch, wallet: w, stack: async () => stack, fallback: async () => null, clock: () => NOW, perCall: () => ({ requireReceipt: true }) });
    await assert.rejects(() => fetch(url, { method }), (error: unknown) => error instanceof LightningPaymentError && error.code === "LIGHTNING_RECEIPT_UNAVAILABLE");
    assert.deepEqual(w.paid, []);
  });

  it("hands a 402 with only USDC entries to the x402 buyer", async () => {
    const usdcOnly = { ...BASE.payment_required, accepts: [{ ...BASE.payment_required.accepts[0]!, network: "eip155:8453" }] };
    const fallbackCalls: string[] = [];
    const s = seller([() => challengeResponse(usdcOnly)]);
    const w = wallet();
    const fetch = createLightningFetch({ pairingUri: URI, baseFetch: s.fetch, wallet: w, stack: async () => stack, fallback: async () => async (input) => { fallbackCalls.push(String(input)); return new Response("ok", { status: 200 }); } });
    const response = await fetch(url, { method });
    assert.equal(response.status, 200);
    assert.deepEqual(fallbackCalls, [url]);
    assert.deepEqual(w.paid, []);
  });

  it("pay.fetch's executor reports the lnbtc payment it made", async () => {
    const s = seller([() => challengeResponse(), paidResponse]);
    const w = wallet();
    const pay = createLightningPayExecutor({ pairingUri: URI, baseFetch: s.fetch, wallet: w, stack: async () => stack, fallback: async () => null, clock: () => NOW });
    const result = await pay(url, { method }, { maxUsdMicros: 0, requireReceipt: false, maxSats: 100 });
    assert.equal(result.outcome, "settled");
    assert.equal(result.payment?.network, LNBTC_MAINNET);
    assert.equal(result.payment?.transaction, BASE.payer_result.payment_hash);
    assert.equal(result.payment?.amountMsat, 25_000);
    assert.equal(result.payment?.payer, null);
    assert.equal(result.payment?.settlement.status, "verified");
    assert.deepEqual(w.paid, [BASE.payer_result.invoice]);
    const unpaid = await pay(url, { method }, { maxUsdMicros: 0, requireReceipt: false });
    assert.equal(unpaid.outcome, "not_required", "a second call sees the seller's 200 straight away (the seller stub repeats its last reply)");
  });
});
