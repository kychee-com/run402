import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CredentialsProvider } from "../credentials.js";
import {
  PaymentBuyerError,
  Run402,
  isTrustedRun402PaymentUrl,
  isTrustedRun402PendingResponse,
} from "../index.js";

const credentials: CredentialsProvider = {
  async getAuth() {
    return null;
  },
  async getProjectCredentials() {
    return null;
  },
};

describe("Run402.pay.fetch", () => {
  it("passes an unpriced response through with payment: null", async () => {
    const response = new Response("plain response", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    const r = new Run402({
      apiBase: "https://api.run402.test",
      credentials,
      fetch: async () => response,
    });

    const result = await r.pay.fetch("https://tenant.example/free");

    assert.equal(result.response, response);
    assert.equal(result.payment, null);
    assert.equal(result.outcome, "not_required");
    assert.equal(await result.response.text(), "plain response");
  });

  it("forwards Idempotency-Key without mutating caller headers", async () => {
    const callerHeaders = { "x-caller": "present" };
    let seenHeaders = new Headers();
    const r = new Run402({
      apiBase: "https://api.run402.test",
      credentials,
      fetch: async (_input, init) => {
        seenHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ deduplicated: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await r.pay.fetch(
      "https://api.run402.test/functions/v1/paid",
      { method: "POST", headers: callerHeaders, body: "{}" },
      { idempotencyKey: "paid:call:1" },
    );

    assert.equal(seenHeaders.get("idempotency-key"), "paid:call:1");
    assert.equal(seenHeaders.get("x-caller"), "present");
    assert.deepEqual(callerHeaders, { "x-caller": "present" });
    assert.equal(result.replay, true);
  });

  it("fails a 402 locally when no payment executor is configured", async () => {
    const challenge = Buffer.from(JSON.stringify({
      x402Version: 2,
      resource: { url: "https://tenant.example/paid" },
      accepts: [{
        scheme: "exact",
        network: "eip155:8453",
        asset: "0xusdc",
        amount: "10000",
        payTo: "0xfeed",
        maxTimeoutSeconds: 300,
        extra: {},
      }],
    })).toString("base64url");
    const r = new Run402({
      apiBase: "https://api.run402.test",
      credentials,
      fetch: async () => new Response("payment required", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": challenge },
      }),
    });

    await assert.rejects(r.pay.fetch("https://tenant.example/paid"), (error: unknown) => {
      assert.ok(error instanceof PaymentBuyerError);
      assert.equal(error.code, "PAYMENT_WALLET_UNFUNDED");
      assert.equal(error.fundsMoved, false);
      assert.ok(error.nextActions?.some((action) => action.type === "fund_wallet"));
      return true;
    });
  });
});

describe("Run402 trusted pending classifier", () => {
  it("accepts exact managed/deployment labels and rejects suffix confusion", () => {
    assert.equal(isTrustedRun402PaymentUrl("https://ancestor.run402.app/tribute"), true);
    assert.equal(isTrustedRun402PaymentUrl("https://dpl-abc.sites.run402.com/tribute"), true);
    assert.equal(isTrustedRun402PaymentUrl("https://api.run402.com/tribute"), false);
    assert.equal(isTrustedRun402PaymentUrl("https://a.b.run402.app/tribute"), false);
    assert.equal(isTrustedRun402PaymentUrl("https://ancestor.run402.app.evil.test/tribute"), false);
    assert.equal(isTrustedRun402PaymentUrl("https://run402.app.evil.test/tribute"), false);
    assert.equal(isTrustedRun402PaymentUrl("https://custom.example/tribute"), false);
    assert.equal(isTrustedRun402PaymentUrl("http://ancestor.run402.app/tribute"), false);
    assert.equal(isTrustedRun402PaymentUrl("http://localhost:7777/tribute", { allowTestLocalhost: true }), true);
  });

  it("requires the complete status/code/header/origin/payment/no-redirect predicate", () => {
    const requestUrl = "https://ancestor.run402.app/tribute";
    const response = responseAt(requestUrl, JSON.stringify({ code: "PAYMENT_INTENT_PENDING" }), {
      status: 409,
      headers: {
        "content-type": "application/json",
        "x-run402-payment-intent-state": "pending",
      },
    });
    const envelope = { code: "PAYMENT_INTENT_PENDING" };
    assert.equal(isTrustedRun402PendingResponse({
      requestUrl,
      response,
      envelope,
      paymentBearing: true,
      redirectsDisabled: true,
    }), true);
    assert.equal(isTrustedRun402PendingResponse({
      requestUrl,
      response,
      envelope,
      paymentBearing: false,
      redirectsDisabled: true,
    }), false);
    assert.equal(isTrustedRun402PendingResponse({
      requestUrl: "https://custom.example/tribute",
      response: responseAt("https://custom.example/tribute", "{}", {
        status: 409,
        headers: { "content-type": "application/json", "x-run402-payment-intent-state": "pending" },
      }),
      envelope,
      paymentBearing: true,
      redirectsDisabled: true,
    }), false);
  });
});

function responseAt(url: string, body: BodyInit | null, init: ResponseInit): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}
