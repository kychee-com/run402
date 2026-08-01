import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import bolt11 from "bolt11";
import { Challenge } from "mppx";

import {
  PaymentBuyerError,
  RUN402_MPP_LIGHTNING_PROFILE,
  Run402,
} from "../index.js";
import type { CredentialsProvider } from "../credentials.js";
import { createDynamicPaymentBuyer } from "./dynamic-payment-buyer.js";
import type {
  LightningWalletAdapter,
  LightningWalletPaymentResult,
} from "./lightning-wallet-adapter.js";
import type { PaymentAttemptRecord, PaymentAttemptStore } from "./payment-attempts.js";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const PREIMAGE = "55".repeat(32);
const PAYMENT_HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");
const SIGNER = "01".repeat(32);
const PAYMENT_SECRET = "22".repeat(32);
const INVOICE_TIMESTAMP = Math.floor(NOW.getTime() / 1_000) - 10;
const INVOICE_EXPIRES = new Date((INVOICE_TIMESTAMP + 300) * 1_000);
const ORIGIN = "https://api.run402.test";
const URL = `${ORIGIN}/tiers/v1/prototype`;

const credentials: CredentialsProvider = {
  async getAuth() { return null; },
  async getProjectCredentials() { return null; },
};

function signedInvoice(bitcoinNetwork: "regtest" | "mainnet" = "regtest"): string {
  const network = bitcoinNetwork === "mainnet"
    ? { bech32: "bc", pubKeyHash: 0x00, scriptHash: 0x05, validWitnessVersions: [0, 1] }
    : { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, validWitnessVersions: [0, 1] };
  const payload = {
    network,
    timestamp: INVOICE_TIMESTAMP,
    satoshis: 1_000,
    tags: [
      { tagName: "payment_hash", data: PAYMENT_HASH },
      { tagName: "payment_secret", data: PAYMENT_SECRET },
      { tagName: "description", data: "Run402 prototype tier" },
      { tagName: "expire_time", data: 300 },
      { tagName: "min_final_cltv_expiry", data: 40 },
      { tagName: "feature_bits", data: {
        var_onion_optin: { required: true, supported: false },
        payment_secret: { required: true, supported: false },
        basic_mpp: { required: false, supported: true },
        extra_bits: {
          start_bit: 20,
          bits: [false, false, false, false, false, true],
        },
      } },
    ],
  };
  return bolt11.sign(bolt11.encode(payload as never, false), SIGNER).paymentRequest;
}

class MemoryAttemptStore implements PaymentAttemptStore {
  record: PaymentAttemptRecord | null = null;
  claim(record: PaymentAttemptRecord) {
    if (this.record) return false;
    this.record = structuredClone(record);
    return true;
  }
  write(record: PaymentAttemptRecord) { this.record = structuredClone(record); }
  read(id: string) { return this.record?.payment_attempt_id === id ? structuredClone(this.record) : null; }
}

function wallet(
  result: LightningWalletPaymentResult,
  network: "regtest" | "mainnet" = "regtest",
): LightningWalletAdapter & {
  dispatches: number;
  lookups: number;
} {
  const payee = bolt11.decode(signedInvoice(network)).payeeNodeKey!;
  return {
    alias: "nwc:deploy-bot",
    provider: "alby_hub_lnd_fixed_fee_v1",
    providerCommit: "32af89bc8c6626d6b8cf35c53c1b2fcdc38950ec",
    backend: "lnd",
    feePolicy: "max_1pct_or_10000msat",
    network,
    payeeNodePubkeys: [payee],
    atomicFeeCap: true,
    dispatches: 0,
    lookups: 0,
    async preparePayment() {
      return {
        walletRequestId: "nwc-event-1",
        providerFeeCeilingMsat: 10_000,
        dispatch: async () => { this.dispatches += 1; return result; },
      };
    },
    async lookupPayment() { this.lookups += 1; return result; },
  };
}

function discovery(
  invoice: string,
  contentDigest: string,
  network: "regtest" | "mainnet" = "regtest",
): Response {
  const challengeId = "00000000-0000-4000-8000-000000000001";
  const challenge = Challenge.from({
    id: challengeId,
    realm: "api.run402.test",
    method: "lightning",
    intent: "charge",
    request: {
      amount: "1000",
      currency: "sat",
      description: "Run402 prototype tier",
      methodDetails: { invoice, paymentHash: PAYMENT_HASH, network },
    },
    digest: contentDigest.replace(/^sha-256=:/, "sha-256=").replace(/:$/, ""),
    expires: INVOICE_EXPIRES.toISOString(),
    meta: {
      intent: "pint_1", attempt: "patt_1", operation: "66".repeat(32),
      contract: "77".repeat(32), quote: "88".repeat(32),
    },
  });
  return responseAt(URL, JSON.stringify({
    error: "Payment required",
    code: "PAYMENT_REQUIRED",
    intent_id: "pint_1",
    attempt_id: "patt_1",
    profile: RUN402_MPP_LIGHTNING_PROFILE,
    protocol: "mpp",
    method: "lightning",
    intent: "charge",
    amount_usd_micros: "100000",
    challenge_id: challengeId,
    payment_hash: PAYMENT_HASH,
    invoice_amount_msat: "1000000",
    quote: {
      source: "coinbase_exchange_btc_usd_bid_v1",
      source_reference: "coinbase-sequence-1",
      observed_at: "2026-07-31T11:59:59.000Z",
      rate_usd_micros_per_btc_numerator: "10000000000",
      rate_usd_micros_per_btc_denominator: "1",
      spread_bps: 50,
      quoted_at: NOW.toISOString(),
      valid_until: "2026-07-31T12:00:45.000Z",
    },
    invoice_expires_at: INVOICE_EXPIRES.toISOString(),
    challenge_expires_at: INVOICE_EXPIRES.toISOString(),
    funds_moved: false,
  }), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "www-authenticate": Challenge.serialize(challenge),
    },
  });
}

function success(overrides: Record<string, unknown> = {}): Response {
  const receipt = Buffer.from(JSON.stringify({
    method: "lightning", challengeId: "00000000-0000-4000-8000-000000000001",
    reference: PAYMENT_HASH, status: "success", timestamp: NOW.toISOString(),
  })).toString("base64url");
  const fulfillment = {
    status: "succeeded", wallet: "wallet-principal", action: "subscribe", tier: "prototype",
    previous_tier: null, lease_started_at: NOW.toISOString(),
    lease_expires_at: "2026-08-07T12:00:00.000Z", payment_receipt: receipt,
    payment_identity: {
      rail: "mpp", method: "lightning", intent: "charge", payment_hash: PAYMENT_HASH,
      request_contract_digest: "77".repeat(32),
    },
  };
  return responseAt(URL, JSON.stringify({
    intent_id: "pint_1", attempt_id: "patt_1", profile: RUN402_MPP_LIGHTNING_PROFILE,
    protocol: "mpp", method: "lightning", intent: "charge",
    amount_usd_micros: "100000", payment_hash: PAYMENT_HASH,
    payment_state: {
      invoice_amount_msat: "1000000", received_amount_msat: "1000000",
      excess_amount_msat: "0", raw_node_state: "SETTLED",
      terminality: "terminal_paid", settlement_role: "primary", recovery: "none",
    },
    fulfillment,
    current_status: { tier: "prototype", active: true },
    attestations: [], credits: [], payment_replay: true, funds_moved: false,
    ...overrides,
  }), { status: 201, headers: { "content-type": "application/json", "payment-receipt": receipt } });
}

function acceptedPending(): Response {
  return responseAt(URL, JSON.stringify({
    code: "PAYMENT_INTENT_PENDING",
    message: "The retained invoice is accepted and remains pending.",
    intent_id: "pint_1",
    attempt_id: "patt_1",
    payment_state: {
      raw_node_state: "ACCEPTED",
      terminality: "nonterminal",
      recovery: "none",
    },
    funds_moved: false,
    retryable: true,
    safe_to_retry: false,
    next_actions: [{
      type: "retry",
      request: "repeat_identical",
      reuse_payer: true,
      reuse_idempotency_key: true,
      why: "Repeat the identical request later.",
    }],
  }), {
    status: 409,
    headers: { "content-type": "application/json", "retry-after": "5" },
  });
}

function responseAt(url: string, body: BodyInit | null, init: ResponseInit): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("dynamic MPP Lightning buyer", () => {
  it("accepts an exact mainnet challenge only through a mainnet instrument", async () => {
    const store = new MemoryAttemptStore();
    const walletResult: LightningWalletPaymentResult = {
      state: "settled", paymentHash: PAYMENT_HASH, walletRequestId: "nwc-event-mainnet",
      invoiceAmountMsat: 1_000_000, feesPaidMsat: 2_000, totalDebitMsat: 1_002_000,
      preimageHex: PREIMAGE, providerReference: "provider-mainnet", failureCode: null,
    };
    const instrument = wallet(walletResult, "mainnet");
    let call = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      call += 1;
      const headers = new Headers(init?.headers);
      if (call === 1) {
        return discovery(
          signedInvoice("mainnet"),
          headers.get("content-digest")!,
          "mainnet",
        );
      }
      return success();
    };
    const sdk = new Run402({
      apiBase: ORIGIN,
      credentials,
      payExecutor: createDynamicPaymentBuyer({
        fetch: fetchImpl,
        lightningWallets: [instrument],
        store,
        now: () => NOW,
        valuation: async () => ({
          sellerRateUsdMicrosPerBtc: 10_000_000_000n,
          buyerRateUsdMicrosPerBtc: 10_000_000_000n,
          conservativeRateUsdMicrosPerBtc: 10_000_000_000n,
          sellerResponseInstant: NOW,
          buyerResponseInstant: NOW,
          sellerTradeInstant: NOW,
          buyerSource: "gemini_btcusd_ask_v2",
        }),
      }),
    });
    const result = await sdk.pay.fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json", "sign-in-with-x": "siwx-value" },
      body: "{}",
    }, {
      idempotencyKey: "tier:lightning:mainnet",
      profile: RUN402_MPP_LIGHTNING_PROFILE,
      maxUsdMicros: 200_000,
      maxNativeAmountMsat: 1_010_000,
      maxRoutingFeeMsat: 10_000,
      principalTransport: "siwx",
      paymentPreferences: [{
        protocol: "mpp", method: "lightning", intent: "charge", wallet: "nwc:deploy-bot",
      }],
    });
    assert.equal(instrument.dispatches, 1);
    assert.equal(result.paymentResult?.method, "lightning");
  });

  it("recovers a settled wallet result after a lost HTTP response without another dispatch", async () => {
    const store = new MemoryAttemptStore();
    const walletResult: LightningWalletPaymentResult = {
      state: "settled", paymentHash: PAYMENT_HASH, walletRequestId: "nwc-event-1",
      invoiceAmountMsat: 1_000_000, feesPaidMsat: 2_000, totalDebitMsat: 1_002_000,
      preimageHex: PREIMAGE, providerReference: "provider-result-1", failureCode: null,
    };
    const instrument = wallet(walletResult);
    let call = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      call += 1;
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("idempotency-key"), "tier:lightning:1");
      assert.equal(init?.body?.toString(), "{}");
      if (call === 1) return discovery(signedInvoice(), headers.get("content-digest")!);
      if (call === 2) {
        assert.match(headers.get("authorization") ?? "", /^Payment /);
        throw new Error("response lost");
      }
      if (call === 3) {
        assert.match(headers.get("authorization") ?? "", /^Payment /);
        return success();
      }
      throw new Error("unexpected fetch");
    };
    const makeSdk = () => new Run402({
      apiBase: ORIGIN,
      credentials,
      payExecutor: createDynamicPaymentBuyer({
        fetch: fetchImpl, lightningWallets: [instrument], store, now: () => NOW,
        valuation: async () => ({
          sellerRateUsdMicrosPerBtc: 10_000_000_000n,
          buyerRateUsdMicrosPerBtc: 10_000_000_000n,
          conservativeRateUsdMicrosPerBtc: 10_000_000_000n,
          sellerResponseInstant: NOW, buyerResponseInstant: NOW, sellerTradeInstant: NOW,
          buyerSource: "gemini_btcusd_ask_v2",
        }),
      }),
    });
    const options = {
      idempotencyKey: "tier:lightning:1",
      profile: RUN402_MPP_LIGHTNING_PROFILE,
      maxUsdMicros: 200_000,
      maxNativeAmountMsat: 1_010_000,
      maxRoutingFeeMsat: 10_000,
      principalTransport: "siwx" as const,
      paymentPreferences: [{
        protocol: "mpp" as const, method: "lightning" as const,
        intent: "charge" as const, wallet: "nwc:deploy-bot" as const,
      }],
    };
    const init = {
      method: "POST",
      headers: { "content-type": "application/json", "sign-in-with-x": "siwx-value" },
      body: "{}",
    };

    await assert.rejects(makeSdk().pay.fetch(URL, init, options), (error: unknown) =>
      error instanceof PaymentBuyerError && error.code === "PAYMENT_RECOVERY_PENDING" &&
      error.fundsMoved === true);
    assert.equal(instrument.dispatches, 1);
    assert.equal(instrument.lookups, 0);
    const journal = JSON.stringify(store.record);
    assert.doesNotMatch(journal, new RegExp(PREIMAGE));
    assert.doesNotMatch(journal, /siwx-value|tier:lightning:1|\{\}/);

    await assert.rejects(makeSdk().pay.fetch(URL, { ...init, body: '{"changed":true}' }, options),
      (error: unknown) => error instanceof PaymentBuyerError && error.code === "IDEMPOTENCY_KEY_REUSED");
    assert.equal(instrument.lookups, 0);

    await assert.rejects(makeSdk().pay.fetch(URL, init, {
      ...options,
      principalTransport: "control_plane_cookie" as const,
    }), (error: unknown) => error instanceof PaymentBuyerError &&
      error.code === "IDEMPOTENCY_KEY_REUSED" &&
      Array.isArray((error.details as Record<string, unknown>).mismatch_fields) &&
      ((error.details as Record<string, unknown>).mismatch_fields as unknown[])
        .includes("principal_transport"));
    assert.equal(instrument.lookups, 0);

    const recovered = await makeSdk().pay.fetch(URL, init, options);
    assert.equal(instrument.dispatches, 1);
    assert.equal(instrument.lookups, 1);
    assert.equal(recovered.paymentResult?.method, "lightning");
    assert.equal(recovered.paymentResult?.fundsMoved, false);
    assert.equal(recovered.paymentResult?.rawNodeState, "SETTLED");
    assert.equal(recovered.paymentResult?.merchantFulfillment &&
      (recovered.paymentResult.merchantFulfillment as { tier: string }).tier, "prototype");
  });

  it("rejects a success response that does not match the retained intent", async () => {
    const store = new MemoryAttemptStore();
    const walletResult: LightningWalletPaymentResult = {
      state: "settled", paymentHash: PAYMENT_HASH, walletRequestId: "nwc-event-1",
      invoiceAmountMsat: 1_000_000, feesPaidMsat: 2_000, totalDebitMsat: 1_002_000,
      preimageHex: PREIMAGE, providerReference: "provider-result-1", failureCode: null,
    };
    const instrument = wallet(walletResult);
    let call = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      call += 1;
      const headers = new Headers(init?.headers);
      if (call === 1) return discovery(signedInvoice(), headers.get("content-digest")!);
      return success({ intent_id: "pint_other" });
    };
    const sdk = new Run402({
      apiBase: ORIGIN,
      credentials,
      payExecutor: createDynamicPaymentBuyer({
        fetch: fetchImpl, lightningWallets: [instrument], store, now: () => NOW,
        valuation: async () => ({
          sellerRateUsdMicrosPerBtc: 10_000_000_000n,
          buyerRateUsdMicrosPerBtc: 10_000_000_000n,
          conservativeRateUsdMicrosPerBtc: 10_000_000_000n,
          sellerResponseInstant: NOW, buyerResponseInstant: NOW, sellerTradeInstant: NOW,
          buyerSource: "gemini_btcusd_ask_v2",
        }),
      }),
    });
    await assert.rejects(sdk.pay.fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json", "sign-in-with-x": "siwx-value" },
      body: "{}",
    }, {
      idempotencyKey: "tier:lightning:response-mismatch",
      profile: RUN402_MPP_LIGHTNING_PROFILE,
      maxUsdMicros: 200_000,
      maxNativeAmountMsat: 1_010_000,
      maxRoutingFeeMsat: 10_000,
      principalTransport: "siwx",
      paymentPreferences: [{
        protocol: "mpp", method: "lightning", intent: "charge", wallet: "nwc:deploy-bot",
      }],
    }), (error: unknown) => error instanceof PaymentBuyerError &&
      error.code === "PAYMENT_EVIDENCE_INVALID" && error.fundsMoved === true);
    assert.equal(instrument.dispatches, 1);
  });

  it("keeps ACCEPTED pinned after invoice expiry without another dispatch or discovery", async () => {
    const store = new MemoryAttemptStore();
    const walletResult: LightningWalletPaymentResult = {
      state: "settled", paymentHash: PAYMENT_HASH, walletRequestId: "nwc-event-1",
      invoiceAmountMsat: 1_000_000, feesPaidMsat: 2_000, totalDebitMsat: 1_002_000,
      preimageHex: PREIMAGE, providerReference: "provider-result-1", failureCode: null,
    };
    const instrument = wallet(walletResult);
    let call = 0;
    let clock = NOW;
    const fetchImpl: typeof fetch = async (_input, init) => {
      call += 1;
      const headers = new Headers(init?.headers);
      if (call === 1) return discovery(signedInvoice(), headers.get("content-digest")!);
      assert.match(headers.get("authorization") ?? "", /^Payment /);
      return acceptedPending();
    };
    const sdk = new Run402({
      apiBase: ORIGIN,
      credentials,
      payExecutor: createDynamicPaymentBuyer({
        fetch: fetchImpl, lightningWallets: [instrument], store, now: () => clock,
        valuation: async () => ({
          sellerRateUsdMicrosPerBtc: 10_000_000_000n,
          buyerRateUsdMicrosPerBtc: 10_000_000_000n,
          conservativeRateUsdMicrosPerBtc: 10_000_000_000n,
          sellerResponseInstant: NOW, buyerResponseInstant: NOW, sellerTradeInstant: NOW,
          buyerSource: "gemini_btcusd_ask_v2",
        }),
      }),
    });
    const options = {
      idempotencyKey: "tier:lightning:accepted",
      profile: RUN402_MPP_LIGHTNING_PROFILE,
      maxUsdMicros: 200_000,
      maxNativeAmountMsat: 1_010_000,
      maxRoutingFeeMsat: 10_000,
      principalTransport: "siwx" as const,
      paymentPreferences: [{
        protocol: "mpp" as const, method: "lightning" as const,
        intent: "charge" as const, wallet: "nwc:deploy-bot" as const,
      }],
    };
    const init = {
      method: "POST",
      headers: { "content-type": "application/json", "sign-in-with-x": "siwx-value" },
      body: "{}",
    };
    await assert.rejects(sdk.pay.fetch(URL, init, options), (error: unknown) =>
      error instanceof PaymentBuyerError && error.code === "PAYMENT_INTENT_PENDING" &&
      error.fundsMoved === true &&
      (error.body as Record<string, unknown> | null)?.payment_state !== undefined &&
      error.nextActions?.length === 1);
    clock = new Date(INVOICE_EXPIRES.getTime() + 60_000);
    await assert.rejects(sdk.pay.fetch(URL, init, options), (error: unknown) =>
      error instanceof PaymentBuyerError && error.code === "PAYMENT_INTENT_PENDING" &&
      error.fundsMoved === false &&
      (error.body as Record<string, unknown> | null)?.payment_state !== undefined &&
      error.nextActions?.length === 1);
    assert.equal(call, 3);
    assert.equal(instrument.dispatches, 1);
    assert.equal(instrument.lookups, 1);
  });

  it("returns retained received amount, excess, and credit references", async () => {
    const store = new MemoryAttemptStore();
    const walletResult: LightningWalletPaymentResult = {
      state: "settled", paymentHash: PAYMENT_HASH, walletRequestId: "nwc-event-1",
      invoiceAmountMsat: 1_000_000, feesPaidMsat: 2_000, totalDebitMsat: 1_002_000,
      preimageHex: PREIMAGE, providerReference: "provider-result-1", failureCode: null,
    };
    const instrument = wallet(walletResult);
    let call = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      call += 1;
      const headers = new Headers(init?.headers);
      if (call === 1) return discovery(signedInvoice(), headers.get("content-digest")!);
      return success({
        payment_state: {
          invoice_amount_msat: "1000000", received_amount_msat: "1005000",
          excess_amount_msat: "5000", raw_node_state: "SETTLED",
          terminality: "terminal_paid", settlement_role: "primary", recovery: "credited_excess",
        },
        credits: [{ id: "pcredit_1", calculation_kind: "successful_excess", amount_usd_micros: "1" }],
      });
    };
    const sdk = new Run402({
      apiBase: ORIGIN,
      credentials,
      payExecutor: createDynamicPaymentBuyer({
        fetch: fetchImpl, lightningWallets: [instrument], store, now: () => NOW,
        valuation: async () => ({
          sellerRateUsdMicrosPerBtc: 10_000_000_000n,
          buyerRateUsdMicrosPerBtc: 10_000_000_000n,
          conservativeRateUsdMicrosPerBtc: 10_000_000_000n,
          sellerResponseInstant: NOW, buyerResponseInstant: NOW, sellerTradeInstant: NOW,
          buyerSource: "gemini_btcusd_ask_v2",
        }),
      }),
    });
    const result = await sdk.pay.fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json", "sign-in-with-x": "siwx-value" },
      body: "{}",
    }, {
      idempotencyKey: "tier:lightning:credit",
      profile: RUN402_MPP_LIGHTNING_PROFILE,
      maxUsdMicros: 200_000,
      maxNativeAmountMsat: 1_010_000,
      maxRoutingFeeMsat: 10_000,
      principalTransport: "siwx",
      paymentPreferences: [{
        protocol: "mpp", method: "lightning", intent: "charge", wallet: "nwc:deploy-bot",
      }],
    });
    assert.equal(result.paymentResult?.receivedAmountMsat, 1_005_000);
    assert.equal(result.paymentResult?.excessAmountMsat, 5_000);
    assert.equal(result.paymentResult?.recoveryState, "credited_excess");
    assert.deepEqual(result.paymentResult?.credits, [{
      id: "pcredit_1", calculation_kind: "successful_excess", amount_usd_micros: "1",
    }]);
    assert.equal(instrument.dispatches, 1);
  });
});
