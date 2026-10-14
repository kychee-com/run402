import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Challenge } from "mppx";

import { PaymentBuyerError, payFetchResultToJson } from "../namespaces/pay.js";
import { createMppPayExecutor, simpleMppFingerprint, type PreparedMppPayment } from "./mpp-pay-executor.js";
import { paymentNetworkUnsupportedError } from "./paid-fetch.js";
import type { PaymentAttemptRecord, PaymentAttemptStore } from "./payment-attempts.js";
import { mppOffers, paymentOffers, x402Offers } from "./payment-offers.js";

const URL_PAID = "https://seller.run402.app/api/report";
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const BUYER = "0x2222222222222222222222222222222222222222";
const SELLER = "0x9999999999999999999999999999999999999999";
const TX = `0x${"ab".repeat(32)}`;

function tempoChallenge(chainId = 42431, amount = "20000"): string {
  return Challenge.serialize(Challenge.from({
    id: `ch_${chainId}`,
    realm: "seller.run402.app",
    method: "tempo",
    intent: "charge",
    request: { amount, currency: PATH_USD, recipient: SELLER, methodDetails: { chainId } },
  }));
}

function x402Header(network = "eip155:84532"): string {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: { url: URL_PAID },
    accepts: [{ scheme: "exact", network, asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "20000", payTo: SELLER }],
  })).toString("base64");
}

function challengeResponse(headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ code: "PAYMENT_REQUIRED" }), {
    status: 402,
    headers: { "content-type": "application/json", ...headers },
  });
}

function receiptHeader(reference = TX): string {
  return Buffer.from(JSON.stringify({ method: "tempo", reference, status: "success", timestamp: "2026-10-14T10:00:01.000Z" })).toString("base64url");
}

function journal(): { store: PaymentAttemptStore; records: Map<string, PaymentAttemptRecord>; createAttemptId: () => string; now: () => string } {
  const records = new Map<string, PaymentAttemptRecord>();
  let sequence = 0;
  return {
    records,
    store: {
      claim(record) {
        if (records.has(record.payment_attempt_id)) return false;
        records.set(record.payment_attempt_id, structuredClone(record));
        return true;
      },
      write(record) { records.set(record.payment_attempt_id, structuredClone(record)); },
      read(id) { return records.get(id) ?? null; },
    },
    createAttemptId: () => `pat_${(sequence += 1).toString(16).padStart(32, "0")}`,
    now: () => "2026-10-14T10:00:00.000Z",
  };
}

interface Harness {
  credentials: number;
  seen: string[];
}

function executor(seller: (request: Request, harness: Harness) => Response | Promise<Response>, extra: { sleep?: (ms: number) => Promise<void> } = {}) {
  const harness: Harness = { credentials: 0, seen: [] };
  const attempts = journal();
  const pay = createMppPayExecutor({
    payer: BUYER,
    baseFetch: async (input, init) => {
      const request = new Request(input, init);
      const auth = request.headers.get("authorization");
      if (auth) harness.seen.push(auth);
      return seller(request, harness);
    },
    prepare: async (response): Promise<PreparedMppPayment> => {
      const challenges = Challenge.fromResponseList(response).filter((c) => c.method === "tempo");
      const challenge = challenges[0]!;
      return {
        challenge: challenge as PreparedMppPayment["challenge"],
        createCredential: async () => {
          harness.credentials += 1;
          return `Payment cred-${harness.credentials}`;
        },
        setCredential: (request, credential) => {
          const headers = new Headers(request.headers);
          headers.set("Authorization", credential);
          return { ...request, headers };
        },
      };
    },
    unsupported: (offers) => paymentNetworkUnsupportedError(
      [...new Set(offers.flatMap((o) => (o.network ? [o.network] : [])))],
      ["eip155:4217", "eip155:42431"],
      {},
      offers,
      "mpp",
    ),
    fingerprint: simpleMppFingerprint,
    store: attempts.store,
    createAttemptId: attempts.createAttemptId,
    now: attempts.now,
    sleep: extra.sleep ?? (async () => {}),
    allowTestLocalhost: true,
  });
  return { pay, harness, records: attempts.records };
}

const opts = { maxUsdMicros: 50_000, requireReceipt: false };

describe("payment offers", () => {
  it("reads x402 entries and MPP challenges from one 402", () => {
    const response = challengeResponse({
      "PAYMENT-REQUIRED": x402Header(),
      "WWW-Authenticate": `${tempoChallenge(4217)}, ${tempoChallenge(42431)}`,
    });
    assert.deepEqual(x402Offers(response), [{ protocol: "x402", method: "exact", network: "eip155:84532" }]);
    assert.deepEqual(mppOffers(response), [
      { protocol: "mpp", method: "tempo", intent: "charge", network: "eip155:4217" },
      { protocol: "mpp", method: "tempo", intent: "charge", network: "eip155:42431" },
    ]);
    assert.equal(paymentOffers(response).length, 3);
  });

  it("ignores non-Payment schemes in WWW-Authenticate", () => {
    const response = challengeResponse({ "WWW-Authenticate": `Bearer realm="x", ${tempoChallenge()}` });
    assert.deepEqual(mppOffers(response).map((o) => o.network), ["eip155:42431"]);
  });
});

describe("createMppPayExecutor", () => {
  it("pays a Tempo challenge and reports protocol, method, network and the receipt", async () => {
    const { pay, harness, records } = executor((request) => {
      if (!request.headers.get("authorization")) return challengeResponse({ "WWW-Authenticate": tempoChallenge() });
      return new Response(JSON.stringify({ report: "ok" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "Payment-Receipt": receiptHeader(),
          "X-Run402-Payment-Id": "tpay_1",
          "X-Run402-Payment-Deduplicated": "false",
          "X-Run402-Payment-Funds-Moved": "true",
        },
      });
    });

    const result = await pay(URL_PAID, { method: "POST", body: "{}" }, opts);

    assert.equal(harness.credentials, 1);
    assert.deepEqual(harness.seen, ["Payment cred-1"]);
    assert.equal(result.outcome, "settled");
    const payment = result.payment!;
    assert.equal(payment.protocol, "mpp");
    assert.equal(payment.method, "tempo");
    assert.equal(payment.network, "eip155:42431");
    assert.equal(payment.asset, PATH_USD);
    assert.equal(payment.amountUsdMicros, 20_000);
    assert.equal(payment.transaction, TX);
    assert.equal(payment.payTo, SELLER);
    assert.equal(payment.fundsMoved, true);
    assert.equal(payment.paymentId, "tpay_1");
    assert.equal(payment.offer.status, "unavailable");
    assert.equal(payment.merchantReceipt.status, "unavailable");
    const json = payFetchResultToJson(result, { report: "ok" }) as { payment: Record<string, unknown> };
    assert.equal(json.payment.protocol, "mpp");
    assert.equal(json.payment.method, "tempo");
    assert.deepEqual((json.payment.evidence as Record<string, unknown>).protocol_receipt, {
      method: "tempo", reference: TX, status: "success", timestamp: "2026-10-14T10:00:01.000Z",
    });
    const [record] = [...records.values()];
    assert.equal(record!.rail, "mpp");
    assert.equal(record!.state, "completed");
  });

  it("refuses a price above the guard before signing", async () => {
    const { pay, harness } = executor(() => challengeResponse({ "WWW-Authenticate": tempoChallenge(42431, "60000") }));
    await assert.rejects(pay(URL_PAID, { method: "POST" }, opts), (error: unknown) => {
      assert.ok(error instanceof PaymentBuyerError);
      assert.equal(error.code, "PAYMENT_EXCEEDS_MAX");
      assert.equal(error.fundsMoved, false);
      return true;
    });
    assert.equal(harness.credentials, 0);
  });

  it("names the x402 offers and the rail switch when the seller offers x402 only", async () => {
    const { pay, harness } = executor(() => challengeResponse({ "PAYMENT-REQUIRED": x402Header() }));
    await assert.rejects(pay(URL_PAID, undefined, opts), (error: unknown) => {
      assert.ok(error instanceof PaymentBuyerError);
      assert.equal(error.code, "PAYMENT_NETWORK_UNSUPPORTED");
      const details = error.details as Record<string, unknown>;
      assert.deepEqual(details.offers, [{ protocol: "x402", method: "exact", network: "eip155:84532" }]);
      assert.deepEqual(details.challenge_networks, ["eip155:84532"]);
      const body = error.body as { next_actions: Array<{ command?: string }> };
      assert.equal(body.next_actions[0]!.command, "run402 init x402 --switch-rail");
      return true;
    });
    assert.equal(harness.credentials, 0);
  });

  it("re-presents the same credential on an identical retry and reports the dedup", async () => {
    let paid = 0;
    const { pay, harness } = executor((request) => {
      if (!request.headers.get("authorization")) return challengeResponse({ "WWW-Authenticate": tempoChallenge() });
      paid += 1;
      return new Response("{}", {
        status: 200,
        headers: {
          "Payment-Receipt": receiptHeader(),
          "X-Run402-Payment-Id": "tpay_1",
          "X-Run402-Payment-Deduplicated": paid > 1 ? "true" : "false",
          "X-Run402-Payment-Funds-Moved": paid > 1 ? "false" : "true",
        },
      });
    });

    await pay(URL_PAID, { method: "POST" }, opts);
    const again = await pay(URL_PAID, { method: "POST" }, opts);

    assert.equal(harness.credentials, 1);
    assert.deepEqual(harness.seen, ["Payment cred-1", "Payment cred-1"]);
    assert.equal(again.outcome, "already_settled");
    assert.equal(again.replay, true);
    assert.equal(again.payment!.deduplicated, true);
    assert.equal(again.payment!.fundsMoved, false);
    assert.equal(again.payment!.paymentId, "tpay_1");
  });

  it("forgets a cleanly refused credential and signs a fresh one next time", async () => {
    let refusals = 0;
    const { pay, harness } = executor((request) => {
      if (!request.headers.get("authorization")) return challengeResponse({ "WWW-Authenticate": tempoChallenge() });
      if (refusals === 0) {
        refusals += 1;
        return new Response(JSON.stringify({ code: "TENANT_MPP_PAYMENT_INVALID", funds_moved: false }), {
          status: 402,
          headers: { "content-type": "application/json", "WWW-Authenticate": tempoChallenge() },
        });
      }
      return new Response("{}", { status: 200, headers: { "Payment-Receipt": receiptHeader() } });
    });

    await assert.rejects(pay(URL_PAID, { method: "POST" }, opts), (error: unknown) => {
      assert.ok(error instanceof PaymentBuyerError);
      assert.equal(error.code, "PAYMENT_SETTLEMENT_FAILED");
      assert.equal(error.fundsMoved, false);
      assert.equal((error.details as Record<string, unknown>).upstream_code, "TENANT_MPP_PAYMENT_INVALID");
      return true;
    });
    const result = await pay(URL_PAID, { method: "POST" }, opts);
    assert.equal(result.outcome, "settled");
    assert.equal(harness.credentials, 2);
  });

  it("waits out a pending settlement by re-presenting the same credential", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const { pay, harness } = executor((request) => {
      if (!request.headers.get("authorization")) return challengeResponse({ "WWW-Authenticate": tempoChallenge() });
      attempts += 1;
      if (attempts === 1) {
        const pending = new Response(JSON.stringify({ code: "PAYMENT_INTENT_PENDING" }), {
          status: 409,
          headers: { "content-type": "application/json", "retry-after": "2", "x-run402-payment-intent-state": "pending" },
        });
        Object.defineProperty(pending, "url", { value: "http://localhost/api/report" });
        return pending;
      }
      return new Response("{}", { status: 200, headers: { "Payment-Receipt": receiptHeader() } });
    }, { sleep: async (ms) => { waits.push(ms); } });

    const result = await pay("http://localhost/api/report", { method: "POST" }, opts);

    assert.equal(result.outcome, "settled");
    assert.deepEqual(waits, [2000]);
    assert.equal(harness.credentials, 1);
    assert.deepEqual(harness.seen, ["Payment cred-1", "Payment cred-1"]);
  });

  it("reports an unknown outcome when the paid answer carries no receipt and no refusal", async () => {
    const { pay } = executor((request) => {
      if (!request.headers.get("authorization")) return challengeResponse({ "WWW-Authenticate": tempoChallenge() });
      return new Response("upstream exploded", { status: 502 });
    });
    await assert.rejects(pay(URL_PAID, { method: "POST" }, opts), (error: unknown) => {
      assert.ok(error instanceof PaymentBuyerError);
      assert.equal(error.fundsMoved, "unknown");
      return true;
    });
  });

  it("passes an unpriced response through without paying", async () => {
    const { pay, harness } = executor(() => new Response("free", { status: 200 }));
    const result = await pay(URL_PAID, undefined, opts);
    assert.equal(result.outcome, "not_required");
    assert.equal(result.payment, null);
    assert.equal(harness.credentials, 0);
  });
});

describe("x402 rail facing a Tempo-only 402", () => {
  it("names the MPP offer and the switch to the mpp rail", () => {
    const response = challengeResponse({ "WWW-Authenticate": tempoChallenge(4217) });
    const offers = paymentOffers(response);
    const error = paymentNetworkUnsupportedError(["eip155:4217"], ["eip155:8453"], {}, offers, "x402");
    const details = error.details as Record<string, unknown>;
    assert.deepEqual(details.offers, [{ protocol: "mpp", method: "tempo", intent: "charge", network: "eip155:4217" }]);
    const body = error.body as { next_actions: Array<{ command?: string }> };
    assert.equal(body.next_actions[0]!.command, "run402 init mpp --switch-rail");
  });
});
