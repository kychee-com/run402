import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PaymentBuyerError } from "../namespaces/pay.js";
import {
  createX402BuyerFetch,
  X402BalanceError,
  type X402BuyerClient,
} from "./paid-fetch.js";
import type {
  PaymentAttemptRecord,
  PaymentAttemptStore,
} from "./payment-attempts.js";

const PAID_URL = "https://ancestor.run402.app/tribute/1c";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function challenge(
  amount = "10000",
  network = "eip155:8453",
  overrides: { asset?: string; resourceUrl?: string } = {},
): Response {
  return new Response(JSON.stringify({ code: "PAYMENT_REQUIRED" }), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "PAYMENT-REQUIRED": encode({
        x402Version: 2,
        resource: {
          url: overrides.resourceUrl ?? PAID_URL,
          description: "tribute",
          mimeType: "application/json",
        },
        accepts: [{
          scheme: "exact",
          network,
          asset: overrides.asset ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amount,
          payTo: "0xfeed000000000000000000000000000000000000",
          maxTimeoutSeconds: 300,
          extra: {},
        }],
      }),
    },
  });
}

function settlement(network = "eip155:8453"): string {
  return encode({
    success: true,
    payer: "0xbuyer00000000000000000000000000000000000",
    transaction: "0xtransaction",
    network,
  });
}

function fakeClient(onCreate?: () => void): X402BuyerClient {
  return {
    async createPaymentPayload(required) {
      onCreate?.();
      return {
        x402Version: required.x402Version,
        resource: required.resource,
        accepted: required.accepts[0]!,
        payload: { authorization: { nonce: "same-signed-authorization" } },
      };
    },
  };
}

describe("createX402BuyerFetch", () => {
  it("settles a supported exact challenge and returns a faithful receipt", async () => {
    const seenProofs: string[] = [];
    let calls = 0;
    const buyer = createX402BuyerFetch(fakeClient(), {
      supportedNetworks: ["eip155:8453"],
      ...attemptOptions(),
      fetch: async (_input, init) => {
        calls += 1;
        const proof = new Headers(init?.headers).get("payment-signature");
        if (!proof) return challenge();
        seenProofs.push(proof);
        return new Response(JSON.stringify({ tribute: "accepted" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": settlement(),
          },
        });
      },
    });

    const result = await buyer(PAID_URL, { method: "POST" }, { maxUsdMicros: 10000 });

    assert.equal(calls, 2);
    assert.equal(seenProofs.length, 1);
    assert.equal(result.outcome, "settled");
    assert.deepEqual(result.payment, {
      amount_usd_micros: 10000,
      pay_to: "0xfeed000000000000000000000000000000000000",
      network: "eip155:8453",
      tx_ref: "0xtransaction",
      url: PAID_URL,
    });
    assert.deepEqual(await result.response.json(), { tribute: "accepted" });
  });

  it("rejects a challenge above the default ceiling before signing or paying", async () => {
    let creates = 0;
    let calls = 0;
    const buyer = createX402BuyerFetch(fakeClient(() => { creates += 1; }), {
      supportedNetworks: ["eip155:8453"],
      ...attemptOptions(),
      fetch: async () => {
        calls += 1;
        return challenge("5000000");
      },
    });

    await assert.rejects(buyer(PAID_URL, undefined, {}), (error: unknown) => {
      assert.ok(error instanceof PaymentBuyerError);
      assert.equal(error.code, "PAYMENT_EXCEEDS_MAX");
      assert.equal(error.fundsMoved, false);
      assert.deepEqual(error.details, {
        challenged_amount_usd_micros: 5000000,
        funds_moved: false,
        max_usd_micros: 100000,
      });
      assert.match(error.message, /maxUsdMicros/);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(creates, 0);
  });

  it("honors an explicitly raised ceiling", async () => {
    let creates = 0;
    const buyer = createX402BuyerFetch(fakeClient(() => { creates += 1; }), {
      supportedNetworks: ["eip155:8453"],
      ...attemptOptions(),
      fetch: async (_input, init) => {
        if (!new Headers(init?.headers).has("payment-signature")) return challenge("5000000");
        return new Response("ok", {
          headers: { "PAYMENT-RESPONSE": settlement() },
        });
      },
    });

    const result = await buyer(PAID_URL, undefined, { maxUsdMicros: 5000000 });

    assert.equal(creates, 1);
    assert.equal(result.payment?.amount_usd_micros, 5000000);
  });

  it("rejects unsupported challenge networks before signing", async () => {
    let creates = 0;
    const buyer = createX402BuyerFetch(fakeClient(() => { creates += 1; }), {
      supportedNetworks: ["eip155:8453"],
      ...attemptOptions(),
      fetch: async () => challenge("10000", "solana:mainnet"),
    });

    await assert.rejects(buyer(PAID_URL, undefined, {}), (error: unknown) => {
      assert.ok(error instanceof PaymentBuyerError);
      assert.equal(error.code, "PAYMENT_NETWORK_UNSUPPORTED");
      assert.equal(error.fundsMoved, false);
      assert.deepEqual(error.details, {
        challenge_networks: ["solana:mainnet"],
        funds_moved: false,
        wallet_networks: ["eip155:8453"],
      });
      return true;
    });
    assert.equal(creates, 0);
  });

  it("maps a confirmed balance miss to PAYMENT_WALLET_UNFUNDED before signing", async () => {
    const client: X402BuyerClient = {
      async createPaymentPayload() {
        throw new X402BalanceError(
          "X402_INSUFFICIENT_FUNDS",
          "No accepted network has enough USDC.",
          { required_atomic: "10000", network: "eip155:8453" },
        );
      },
    };
    const buyer = createX402BuyerFetch(client, {
      supportedNetworks: ["eip155:8453"],
      ...attemptOptions(),
      fetch: async () => challenge(),
    });

    await assert.rejects(buyer(PAID_URL, undefined, {}), (error: unknown) => {
      assert.ok(error instanceof PaymentBuyerError);
      assert.equal(error.code, "PAYMENT_WALLET_UNFUNDED");
      assert.equal(error.fundsMoved, false);
      assert.equal((error.details as Record<string, unknown>).network, "eip155:8453");
      assert.ok(error.nextActions?.some((action) => action.type === "fund_wallet"));
      return true;
    });
  });

  it("rejects unsupported assets before signing", async () => {
    let creates = 0;
    const unsupportedAsset = "0x0000000000000000000000000000000000000001";
    const buyer = createX402BuyerFetch(fakeClient(() => { creates += 1; }), {
      supportedNetworks: ["eip155:8453"],
      ...attemptOptions(),
      fetch: async () => challenge("10000", "eip155:8453", { asset: unsupportedAsset }),
    });

    await assert.rejects(buyer(PAID_URL, undefined, {}), (error: unknown) => {
      assert.ok(error instanceof PaymentBuyerError);
      assert.equal(error.code, "PAYMENT_NETWORK_UNSUPPORTED");
      assert.equal(error.fundsMoved, false);
      assert.deepEqual(error.details, {
        challenge_assets: [unsupportedAsset],
        challenge_networks: ["eip155:8453"],
        funds_moved: false,
        wallet_assets: ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
        wallet_networks: ["eip155:8453"],
      });
      return true;
    });
    assert.equal(creates, 0);
  });

  it("rejects a challenge bound to a different resource URL before signing", async () => {
    let creates = 0;
    const buyer = createX402BuyerFetch(fakeClient(() => { creates += 1; }), {
      supportedNetworks: ["eip155:8453"],
      ...attemptOptions(),
      fetch: async () => challenge("10000", "eip155:8453", {
        resourceUrl: "https://attacker.example/different-intent",
      }),
    });

    await assert.rejects(buyer(PAID_URL, undefined, {}), (error: unknown) => {
      assert.ok(error instanceof PaymentBuyerError);
      assert.equal(error.code, "PAYMENT_SETTLEMENT_FAILED");
      assert.equal(error.fundsMoved, false);
      assert.deepEqual(error.details, {
        challenge_url: "https://attacker.example/different-intent",
        funds_moved: false,
        request_url: PAID_URL,
      });
      return true;
    });
    assert.equal(creates, 0);
  });

  it("rejects a settlement receipt for a different network", async () => {
    const buyer = createX402BuyerFetch(fakeClient(), {
      supportedNetworks: ["eip155:8453"],
      ...attemptOptions(),
      fetch: async (_input, init) => {
        if (!new Headers(init?.headers).has("payment-signature")) return challenge();
        return new Response("ok", {
          headers: { "PAYMENT-RESPONSE": settlement("eip155:84532") },
        });
      },
    });

    await assert.rejects(buyer(PAID_URL, undefined, {}), (error: unknown) => {
      assert.ok(error instanceof PaymentBuyerError);
      assert.equal(error.code, "PAYMENT_SETTLEMENT_FAILED");
      assert.equal(error.fundsMoved, "unknown");
      assert.deepEqual(error.details, {
        accepted_network: "eip155:8453",
        funds_moved: "unknown",
        receipt_network: "eip155:84532",
        response_status: 200,
      });
      return true;
    });
  });

  it("re-presents the same proof after an ambiguous timeout and reports already_settled", async () => {
    const proofs: string[] = [];
    let calls = 0;
    let creates = 0;
    const buyer = createX402BuyerFetch(fakeClient(() => { creates += 1; }), {
      supportedNetworks: ["eip155:8453"],
      ...attemptOptions(),
      fetch: async (_input, init) => {
        calls += 1;
        const proof = new Headers(init?.headers).get("payment-signature");
        if (!proof) return challenge();
        proofs.push(proof);
        if (proofs.length === 1) throw new TypeError("connection reset after settlement");
        return new Response(JSON.stringify({
          code: "TENANT_X402_PAYMENT_INVALID",
          details: { x402_error: "invalid_payload: authorization nonce already used" },
        }), {
          status: 402,
          headers: {
            "content-type": "application/json",
            "PAYMENT-REQUIRED": encode({
              x402Version: 2,
              error: "invalid_payload: authorization nonce already used",
              resource: { url: PAID_URL },
              accepts: [],
            }),
          },
        });
      },
    });

    await assert.rejects(buyer(PAID_URL, { method: "POST" }, {}), (error: unknown) => {
      assert.ok(error instanceof PaymentBuyerError);
      assert.equal(error.code, "PAYMENT_SETTLEMENT_FAILED");
      assert.equal(error.fundsMoved, "unknown");
      return true;
    });

    const replay = await buyer(PAID_URL, { method: "POST" }, {});

    assert.equal(calls, 3, "challenge + first proof + replayed proof");
    assert.equal(creates, 1, "retry must not mint another authorization");
    assert.equal(proofs.length, 2);
    assert.equal(proofs[0], proofs[1]);
    assert.equal(replay.outcome, "already_settled");
    assert.equal(replay.payment, null, "no tx ref means no pretend settled receipt");
    assert.equal(replay.replay, true);
  });

  it("does not reuse an ambiguous proof under a lower retry ceiling", async () => {
    const proofs: string[] = [];
    let creates = 0;
    let calls = 0;
    const buyer = createX402BuyerFetch(fakeClient(() => { creates += 1; }), {
      supportedNetworks: ["eip155:8453"],
      ...attemptOptions(),
      fetch: async (_input, init) => {
        calls += 1;
        const proof = new Headers(init?.headers).get("payment-signature");
        if (!proof) return challenge("10000");
        proofs.push(proof);
        if (proofs.length === 1) throw new TypeError("connection reset after settlement");
        return new Response("ok", {
          headers: { "PAYMENT-RESPONSE": settlement() },
        });
      },
    });

    await assert.rejects(buyer(PAID_URL, { method: "POST" }, { maxUsdMicros: 100_000 }),
      (error: unknown) => error instanceof PaymentBuyerError && error.fundsMoved === "unknown");
    await assert.rejects(buyer(PAID_URL, { method: "POST" }, { maxUsdMicros: 1_000 }),
      (error: unknown) => error instanceof PaymentBuyerError && error.code === "PAYMENT_EXCEEDS_MAX");

    const replay = await buyer(PAID_URL, { method: "POST" }, { maxUsdMicros: 100_000 });
    assert.equal(replay.outcome, "settled");
    assert.equal(replay.replay, true);
    assert.equal(calls, 4, "challenge + ambiguous proof + lower-ceiling challenge + original proof retry");
    assert.equal(creates, 1);
    assert.deepEqual(proofs, [proofs[0], proofs[0]]);
  });

  it("collapses concurrent identical challenges onto one signed proof", async () => {
    let challengeCalls = 0;
    let creates = 0;
    let releaseChallenges!: () => void;
    const bothChallenges = new Promise<void>((resolve) => {
      releaseChallenges = resolve;
    });
    const proofs: string[] = [];
    const buyer = createX402BuyerFetch(fakeClient(() => { creates += 1; }), {
      supportedNetworks: ["eip155:8453"],
      ...attemptOptions(),
      fetch: async (_input, init) => {
        const proof = new Headers(init?.headers).get("payment-signature");
        if (!proof) {
          challengeCalls += 1;
          if (challengeCalls === 2) releaseChallenges();
          await bothChallenges;
          return challenge();
        }
        proofs.push(proof);
        return new Response("ok", {
          headers: { "PAYMENT-RESPONSE": settlement() },
        });
      },
    });

    const [first, second] = await Promise.all([
      buyer(PAID_URL, { method: "POST" }, { maxUsdMicros: 100_000 }),
      buyer(PAID_URL, { method: "POST" }, { maxUsdMicros: 100_000 }),
    ]);

    assert.equal(first.outcome, "settled");
    assert.equal(second.outcome, "settled");
    assert.equal(creates, 1);
    assert.equal(proofs.length, 2);
    assert.equal(proofs[0], proofs[1]);
  });

  it("surfaces self-pay as a structured settlement failure with upstream detail", async () => {
    const buyer = createX402BuyerFetch(fakeClient(), {
      supportedNetworks: ["eip155:8453"],
      ...attemptOptions(),
      fetch: async (_input, init) => {
        if (!new Headers(init?.headers).has("payment-signature")) return challenge();
        return new Response(JSON.stringify({
          code: "TENANT_X402_PAYMENT_INVALID",
          details: { x402_error: "self_send_not_allowed" },
        }), {
          status: 402,
          headers: { "content-type": "application/json", "PAYMENT-REQUIRED": encode({
            x402Version: 2,
            error: "self_send_not_allowed",
            resource: { url: PAID_URL },
            accepts: [],
          }) },
        });
      },
    });

    await assert.rejects(buyer(PAID_URL, undefined, {}), (error: unknown) => {
      assert.ok(error instanceof PaymentBuyerError);
      assert.equal(error.code, "PAYMENT_SETTLEMENT_FAILED");
      assert.equal(error.fundsMoved, false);
      assert.equal((error.details as Record<string, unknown>).upstream_code, "TENANT_X402_PAYMENT_INVALID");
      assert.equal((error.details as Record<string, unknown>).x402_error, "self_send_not_allowed");
      assert.doesNotMatch(JSON.stringify(error), /same-signed-authorization|payment-signature/i);
      return true;
    });
  });
});

function attemptOptions(): {
  store: PaymentAttemptStore;
  createAttemptId: () => string;
  now: () => string;
} {
  const records = new Map<string, PaymentAttemptRecord>();
  let sequence = 0;
  return {
    store: {
      claim(record) {
        if (records.has(record.payment_attempt_id)) return false;
        records.set(record.payment_attempt_id, structuredClone(record));
        return true;
      },
      write(record) {
        records.set(record.payment_attempt_id, structuredClone(record));
      },
      read(id) {
        return records.get(id) ?? null;
      },
    },
    createAttemptId() {
      sequence += 1;
      return `pat_${sequence.toString(16).padStart(32, "0")}`;
    },
    now: () => "2026-07-22T12:00:00.000Z",
  };
}
