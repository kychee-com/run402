import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  AlbyHubLndNwcAdapter,
  type NwcRpcTransport,
  type PreparedNwcRequest,
} from "./alby-hub-nwc-adapter.js";

const PREIMAGE = "55".repeat(32);
const PAYMENT_HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");
const PAYEE = `02${"11".repeat(32)}`;

describe("approved Alby Hub LND NWC adapter", () => {
  it("prepares one stable request id and recovers final amount, fee, total, and preimage", async () => {
    const prepared: PreparedNwcRequest[] = [];
    const transport: NwcRpcTransport = {
      prepare(method, params) {
        const request = { id: `event-${method}-${prepared.length}`, method, event: { params } };
        prepared.push(request);
        return request;
      },
      async execute(request) {
        if (request.method === "pay_invoice") {
          return {
            requestId: request.id, responseEventId: "response-pay", resultType: "pay_invoice",
            result: { preimage: PREIMAGE }, error: null,
          };
        }
        return {
          requestId: request.id, responseEventId: "response-lookup", resultType: "lookup_invoice",
          result: {
            payment_hash: PAYMENT_HASH, preimage: PREIMAGE,
            amount_msat: 1_000_000, fees_paid_msat: 2_000,
          },
          error: null,
        };
      },
    };
    const adapter = new AlbyHubLndNwcAdapter({
      alias: "nwc:deploy-bot", network: "mainnet", payeeNodePubkeys: [PAYEE], transport,
    });
    const payment = await adapter.preparePayment({
      invoice: "lnbcrt...", paymentHash: PAYMENT_HASH,
      invoiceAmountMsat: 1_000_000, authorizedMaxFeeMsat: 10_000,
    });
    assert.equal(payment.walletRequestId, "event-pay_invoice-0");
    const result = await payment.dispatch();
    assert.equal(result.state, "settled");
    assert.equal(result.invoiceAmountMsat, 1_000_000);
    assert.equal(result.feesPaidMsat, 2_000);
    assert.equal(result.totalDebitMsat, 1_002_000);
    assert.equal(result.preimageHex, PREIMAGE);
    assert.equal(prepared.filter((item) => item.method === "pay_invoice").length, 1);
  });

  it("refuses before preparation when the caller fee bound is below the provider ceiling", async () => {
    let prepared = false;
    const adapter = new AlbyHubLndNwcAdapter({
      alias: "nwc:deploy-bot", network: "regtest", payeeNodePubkeys: [PAYEE],
      transport: {
        prepare() { prepared = true; throw new Error("must not prepare"); },
        async execute() { throw new Error("must not execute"); },
      },
    });
    await assert.rejects(adapter.preparePayment({
      invoice: "lnbcrt...", paymentHash: PAYMENT_HASH,
      invoiceAmountMsat: 1_000_000, authorizedMaxFeeMsat: 9_999,
    }), /PAYMENT_WALLET_FEE_CAP_UNSUPPORTED/);
    assert.equal(prepared, false);
  });
});
