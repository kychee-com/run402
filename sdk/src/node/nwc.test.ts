/**
 * The agent-side NWC client: pairing URIs parse, a request round-trips
 * NIP-44 v2 through a fake wallet on the transport seam, wallet errors and
 * a reply from the wrong key surface as NwcError codes, and the wallet verbs
 * map msat to sats and return the preimage the wallet reports.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { schnorr } from "@noble/curves/secp256k1.js";

import {
  NWC_REQUEST_KIND,
  NWC_RESPONSE_KIND,
  NwcError,
  NwcWallet,
  nip44ConversationKey,
  nip44Decrypt,
  nip44Encrypt,
  nwcRequest,
  parseNwcUri,
  signNwcEvent,
  type NwcNostrEvent,
  type NwcTransport,
} from "./nwc.js";

const WALLET_SECRET = "0000000000000000000000000000000000000000000000000000000000000002";
const WALLET_PUB = Buffer.from(schnorr.getPublicKey(Buffer.from(WALLET_SECRET, "hex"))).toString("hex");
const CLIENT_SECRET = "0000000000000000000000000000000000000000000000000000000000000001";
const URI = `nostr+walletconnect://${WALLET_PUB}?relay=wss%3A%2F%2Frelay.example%2Fv1&secret=${CLIENT_SECRET}`;

/** A fake Hub: decrypts the request, answers under the wallet key. */
function fakeWallet(
  answer: (method: string, params: Record<string, unknown>) => Record<string, unknown>,
  signWith = WALLET_SECRET,
): NwcTransport & { seen: Array<{ method: string; params: Record<string, unknown> }> } {
  const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
  const transport = (async (_connection, request: NwcNostrEvent) => {
    assert.equal(request.kind, NWC_REQUEST_KIND);
    assert.ok(request.tags.some((tag) => tag[0] === "encryption" && tag[1] === "nip44_v2"));
    const key = nip44ConversationKey(WALLET_SECRET, request.pubkey);
    const body = JSON.parse(nip44Decrypt(key, request.content)) as { method: string; params: Record<string, unknown> };
    seen.push(body);
    const reply = answer(body.method, body.params);
    const content = nip44Encrypt(key, JSON.stringify(reply));
    return signNwcEvent(signWith, NWC_RESPONSE_KIND, [["p", request.pubkey], ["e", request.id]], content);
  }) as NwcTransport & { seen: typeof seen };
  transport.seen = seen;
  return transport;
}

describe("parseNwcUri", () => {
  it("parses the wallet pubkey, relay, and secret and derives the client pubkey", () => {
    const connection = parseNwcUri(URI);
    assert.equal(connection.walletPubkey, WALLET_PUB);
    assert.equal(connection.relayUrl, "wss://relay.example/v1");
    assert.equal(connection.secretHex, CLIENT_SECRET);
    assert.equal(connection.clientPubkey, Buffer.from(schnorr.getPublicKey(Buffer.from(CLIENT_SECRET, "hex"))).toString("hex"));
  });

  it("refuses a URI without a relay or secret", () => {
    assert.throws(() => parseNwcUri(`nostr+walletconnect://${WALLET_PUB}?relay=wss%3A%2F%2Fr`), /secret/);
    assert.throws(() => parseNwcUri(`nostr+walletconnect://${WALLET_PUB}?secret=${CLIENT_SECRET}`), /relay/);
    assert.throws(() => parseNwcUri("https://example.com"), /nostr\+walletconnect/);
  });
});

describe("nwcRequest", () => {
  it("round-trips a signed NIP-44 request and returns the wallet's result", async () => {
    const transport = fakeWallet((method) => ({ result_type: method, result: { invoice: "lnbc1fake", payment_hash: "ab".repeat(32) } }));
    const result = await nwcRequest<{ invoice: string }>(parseNwcUri(URI), "make_invoice", { amount: 1_000 }, { transport });
    assert.equal(result.invoice, "lnbc1fake");
    assert.deepEqual(transport.seen, [{ method: "make_invoice", params: { amount: 1_000 } }]);
  });

  it("maps a wallet error reply to its code", async () => {
    const transport = fakeWallet(() => ({ error: { code: "QUOTA_EXCEEDED", message: "budget spent" } }));
    await assert.rejects(nwcRequest(parseNwcUri(URI), "pay_invoice", { invoice: "lnbc1" }, { transport }), (error: unknown) => {
      assert.ok(error instanceof NwcError);
      assert.equal(error.code, "QUOTA_EXCEEDED");
      return true;
    });
  });

  it("refuses a reply that is not signed by the wallet", async () => {
    const transport = fakeWallet((method) => ({ result_type: method, result: {} }), "0000000000000000000000000000000000000000000000000000000000000003");
    await assert.rejects(nwcRequest(parseNwcUri(URI), "get_info", {}, { transport }), (error: unknown) => {
      assert.ok(error instanceof NwcError);
      assert.equal(error.code, "BAD_RESPONSE");
      return true;
    });
  });
});

describe("NwcWallet verbs", () => {
  function walletWith(replies: Record<string, Record<string, unknown> | NwcError>): NwcWallet {
    const transport = fakeWallet((method) => {
      const reply = replies[method];
      if (reply instanceof NwcError) return { error: { code: reply.code, message: reply.message } };
      return { result_type: method, result: reply ?? {} };
    });
    return new NwcWallet(URI, { transport });
  }

  it("reports balance and budget in sats and returns the preimage from pay_invoice", async () => {
    const wallet = walletWith({
      get_balance: { balance: 123_456 },
      get_budget: { used_budget: 1_000_000, total_budget: 10_000_000, renews_at: null },
      pay_invoice: { preimage: "AB".repeat(32), fees_paid: 0 },
      lookup_invoice: { state: "settled", preimage: "ab".repeat(32) },
    });
    assert.equal(await wallet.getBalanceSats(), 123);
    assert.deepEqual(await wallet.getBudgetSats(), { usedSats: 1_000, totalSats: 10_000, renewsAtSeconds: null });
    assert.deepEqual(await wallet.payInvoice("lnbc1"), { preimage: "ab".repeat(32), feesPaidMsat: 0 });
    assert.deepEqual(await wallet.lookupInvoice("ab".repeat(32)), { state: "settled", preimage: "ab".repeat(32) });
  });

  it("treats a missing budget and a NOT_FOUND lookup as null, and a payment without a preimage as a bad response", async () => {
    const wallet = walletWith({
      get_budget: new NwcError("NOT_IMPLEMENTED", "no"),
      lookup_invoice: new NwcError("NOT_FOUND", "gone"),
      pay_invoice: { fees_paid: 0 },
    });
    assert.equal(await wallet.getBudgetSats(), null);
    assert.equal(await wallet.lookupInvoice("ab".repeat(32)), null);
    await assert.rejects(wallet.payInvoice("lnbc1"), /no preimage/);
  });
});
