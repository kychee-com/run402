import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import * as offerReceipt from "./index.js";

const MERCHANT = privateKeyToAccount("0x1111111111111111111111111111111111111111111111111111111111111111");
const OTHER = privateKeyToAccount("0x3333333333333333333333333333333333333333333333333333333333333333");
const { verifyOfferSignatureEIP712, verifyReceiptSignatureEIP712 } = offerReceipt.offerReceiptVerifiers(recoverTypedDataAddress);

const OFFER_PAYLOAD = {
  version: 1,
  resourceUrl: "https://ancestor.run402.app/tribute/1c",
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: MERCHANT.address,
  amount: "10000",
  validUntil: 1_900_000_000,
};

async function signOffer(account = MERCHANT, payload = OFFER_PAYLOAD) {
  const signature = await account.signTypedData({
    domain: { name: "x402 offer", version: "1", chainId: 1 },
    types: {
      Offer: [
        { name: "version", type: "uint256" },
        { name: "resourceUrl", type: "string" },
        { name: "scheme", type: "string" },
        { name: "network", type: "string" },
        { name: "asset", type: "string" },
        { name: "payTo", type: "string" },
        { name: "amount", type: "string" },
        { name: "validUntil", type: "uint256" },
      ],
    },
    primaryType: "Offer",
    message: { ...payload, version: BigInt(payload.version), validUntil: BigInt(payload.validUntil) },
  });
  return { format: "eip712", payload, signature, acceptIndex: 1 };
}

describe("vendored x402 offer-receipt", () => {
  it("recovers the signer of an EIP-712 offer, and a different one for a changed offer", async () => {
    const offer = await signOffer();
    assert.equal((await verifyOfferSignatureEIP712(offer)).signer, MERCHANT.address);
    const altered = { ...offer, payload: { ...offer.payload, amount: "1" } };
    assert.notEqual((await verifyOfferSignatureEIP712(altered)).signer, MERCHANT.address);
    assert.equal((await verifyOfferSignatureEIP712(await signOffer(OTHER))).signer, OTHER.address);
  });

  it("reads offers from a 402 challenge and matches each to its accepts entry", async () => {
    const offer = await signOffer();
    const required = { extensions: { "offer-receipt": { info: { offers: [offer] } } } };
    const [decoded] = offerReceipt.decodeSignedOffers(offerReceipt.extractOffersFromPaymentRequired(required)) as Array<Record<string, unknown>>;
    assert.equal(decoded!.amount, "10000");
    assert.equal(decoded!.signedOffer, offer);
    const match = { scheme: "exact", network: "eip155:8453", asset: OFFER_PAYLOAD.asset, payTo: MERCHANT.address, amount: "10000" };
    const accepts = [{ ...match, amount: "5" }, match];
    assert.equal(offerReceipt.findAcceptsObjectFromSignedOffer(decoded, accepts), accepts[1]);
    assert.equal(offerReceipt.findAcceptsObjectFromSignedOffer(decoded, [{ ...match, payTo: OTHER.address }]), undefined);
    assert.deepEqual(offerReceipt.extractOffersFromPaymentRequired({}), []);
  });

  it("reads a receipt from PAYMENT-RESPONSE and recovers its signer", async () => {
    const payload = { version: 1, network: "eip155:8453", resourceUrl: OFFER_PAYLOAD.resourceUrl, payer: OTHER.address, issuedAt: 1_800_000_000, transaction: "0xabc" };
    const signature = await MERCHANT.signTypedData({
      domain: { name: "x402 receipt", version: "1", chainId: 1 },
      types: {
        Receipt: [
          { name: "version", type: "uint256" },
          { name: "network", type: "string" },
          { name: "resourceUrl", type: "string" },
          { name: "payer", type: "string" },
          { name: "issuedAt", type: "uint256" },
          { name: "transaction", type: "string" },
        ],
      },
      primaryType: "Receipt",
      message: { ...payload, version: 1n, issuedAt: BigInt(payload.issuedAt) },
    });
    const receipt = { format: "eip712", payload, signature };
    const header = Buffer.from(JSON.stringify({ success: true, extensions: { "offer-receipt": { info: { receipt } } } })).toString("base64");
    const extracted = offerReceipt.extractReceiptFromResponse(new Response(null, { headers: { "PAYMENT-RESPONSE": header } }));
    assert.ok(offerReceipt.isEIP712SignedReceipt(extracted));
    assert.equal((await verifyReceiptSignatureEIP712(extracted)).signer, MERCHANT.address);
    assert.equal(offerReceipt.extractReceiptFromResponse(new Response(null, { headers: { "PAYMENT-RESPONSE": "not base64!" } })), undefined);
    assert.equal(offerReceipt.extractReceiptFromResponse(new Response(null)), undefined);
  });
});
