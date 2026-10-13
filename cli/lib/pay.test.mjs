import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { parseMaxSats, parseUsdMicros, readLightningPairing, run, strayArgumentHint } from "./pay.mjs";

describe("run402 pay", () => {
  it("converts decimal USD to micros without floating-point rounding", () => {
    assert.equal(parseUsdMicros("0.05"), 50_000);
    assert.equal(parseUsdMicros("1.000001"), 1_000_001);
    assert.equal(parseUsdMicros("0"), 0);
  });

  // `--json` selects output format, `--body` sends the payload. An agent
  // reaching for `--json '<payload>'` gets a stray positional; the hint has to
  // name --body or the usage error reads as "the payload was accepted".
  it("points --json '<payload>' at --body", () => {
    const payload = '{"kind":"anon"}';
    const hint = strayArgumentHint(["https://s.example/x", "--json", payload], payload);
    assert.match(hint, /--json only selects JSON output and takes no value/);
    assert.match(hint, /--body '\{"kind":"anon"\}'/);
  });

  it("points a bare JSON positional at --body even without --json", () => {
    const payload = '{"kind":"anon"}';
    const hint = strayArgumentHint(["https://s.example/x", payload], payload);
    assert.match(hint, /pass it as a body: --method POST --body/);
  });

  it("falls back to plain usage for a stray non-JSON argument", () => {
    const hint = strayArgumentHint(["https://s.example/x", "stray"], "stray");
    assert.equal(hint, "run402 pay <url> [--method POST] [--body <value>] [--max-usd 0.10]");
    assert.equal(strayArgumentHint(["https://s.example/x"], undefined), hint);
  });

  it("delegates to SDK pay.fetch and prints the receipt", async () => {
    let captured;
    const output = [];
    await run([
      "https://seller.example/translate",
      "--method", "POST",
      "--body", '{"text":"hello"}',
      "--max-usd", "0.05",
      "--idempotency-key", "translation:1",
      "--require-receipt",
    ], {
      getSdk: () => ({
        pay: {
          async fetch(url, init, options) {
            captured = { url, init, options };
            return {
              response: new Response('{"translated":"hola"}', {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
              payment: {
                network: "eip155:8453",
                paymentId: "txp_cli_1",
                amountUsdMicros: 10_000,
                asset: "USDC",
                payer: "0xbuyer",
                payTo: "0xseller",
                transaction: "0xtx",
                resourceUrl: url,
                settlement: { status: "verified" },
                fundsMoved: true,
                deduplicated: false,
                delivery: { status: "fulfilled", replay: false },
                offer: {
                  status: "verified",
                  resourceUrl: url,
                  validUntil: "2026-07-22T12:05:00.000Z",
                },
                merchantReceipt: {
                  status: "verified",
                  claim: "service_delivered",
                  issuedAt: "2026-07-22T12:00:03.000Z",
                },
                signerRelationship: {
                  kind: "direct",
                  merchantRoot: "0xseller",
                  signer: "0xseller",
                  authorizationExpiresAt: null,
                },
                policy: {
                  requireReceipt: true,
                  status: "satisfied",
                },
                evidence: {
                  offer: { signature: "0xoffer" },
                  merchantReceipt: { signature: "0xreceipt" },
                  signerAuthorization: null,
                },
              },
              outcome: "settled",
              replay: false,
              paymentId: "txp_cli_1",
              deduplicated: false,
              fundsMoved: true,
              delivery: "first",
              settledAt: "2026-07-22T12:00:00.000Z",
              intentState: "settled",
            };
          },
        },
      }),
      write: (value) => output.push(value),
    });

    assert.equal(captured.url, "https://seller.example/translate");
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.body, '{"text":"hello"}');
    assert.equal(new Headers(captured.init.headers).get("content-type"), "application/json");
    assert.deepEqual(captured.options, {
      maxUsdMicros: 50_000,
      idempotencyKey: "translation:1",
      requireReceipt: true,
    });
    assert.deepEqual(JSON.parse(output[0]), {
      schema_version: "x402-commerce-result.v1",
      http_status: 200,
      body: { translated: "hola" },
      payment: {
        amount_usd_micros: 10_000,
        asset: "USDC",
        deduplicated: false,
        delivery: { replay: false, status: "fulfilled" },
        evidence: {
          merchant_receipt: { signature: "0xreceipt" },
          offer: { signature: "0xoffer" },
          signer_authorization: null,
        },
        funds_moved: true,
        merchant_receipt: {
          claim: "service_delivered",
          issued_at: "2026-07-22T12:00:03.000Z",
          status: "verified",
        },
        pay_to: "0xseller",
        payer: "0xbuyer",
        payment_id: "txp_cli_1",
        policy: { require_receipt: true, status: "satisfied" },
        resource_url: "https://seller.example/translate",
        settlement: { status: "verified" },
        signer_relationship: {
          authorization_expires_at: null,
          kind: "direct",
          merchant_root: "0xseller",
          signer: "0xseller",
        },
        network: "eip155:8453",
        transaction: "0xtx",
        offer: {
          resource_url: "https://seller.example/translate",
          status: "verified",
          valid_until: "2026-07-22T12:05:00.000Z",
        },
      },
      outcome: "paid",
      replay: false,
      next_actions: [],
    });
  });
});

describe("run402 pay — Lightning flags (lightning-buyer-any-route)", () => {
  const PAIRING = `nostr+walletconnect://${"ab".repeat(32)}?relay=wss%3A%2F%2Frelay.example&secret=${"cd".repeat(32)}`;

  it("reads the pairing from stdin with - and never from the command line", async () => {
    let captured;
    const output = [];
    await run([
      "https://kychange.com/api/usdc/10k", "--method", "POST", "--body", '{"destination":"0xdead"}',
      "--max-sats", "10500", "--lightning-pairing", "-",
    ], {
      readStdin: () => PAIRING + "\n",
      getSdk: () => ({ pay: { async fetch(url, init, options) { captured = { url, init, options }; return { response: new Response("{}", { status: 202, headers: { "content-type": "application/json" } }), payment: null, outcome: "not_required", replay: false }; } } }),
      write: (value) => output.push(value),
    });
    assert.equal(captured.options.lightningPairing, PAIRING);
    assert.equal(captured.options.maxSats, 10500);
    assert.equal(captured.options.maxUsdMicros, undefined);
    assert.ok(!output.join("\n").includes("nostr+walletconnect"), "the pairing never reaches stdout");
  });

  /** fail() prints the envelope and exits; capture both instead of dying. */
  function captureFail(fn) {
    const logs = [];
    const log = mock.method(console, "log", (value) => { logs.push(String(value)); });
    const error = mock.method(console, "error", (value) => { logs.push(String(value)); });
    const exit = mock.method(process, "exit", () => { throw new Error("__exit__"); });
    try {
      fn();
      throw new Error("did not fail");
    } catch (caught) {
      if (caught.message !== "__exit__") throw caught;
    } finally {
      log.mock.restore(); error.mock.restore(); exit.mock.restore();
    }
    return JSON.parse(logs.at(-1));
  }

  it("refuses the pairing itself as the flag value", () => {
    const envelope = captureFail(() => readLightningPairing(PAIRING));
    assert.equal(envelope.code, "BAD_USAGE");
    assert.match(envelope.message, /file path or -/);
    assert.ok(!JSON.stringify(envelope).includes("secret="), "the refusal never echoes the pairing");
  });

  it("refuses a file that does not hold a pairing", () => {
    const envelope = captureFail(() => readLightningPairing("-", { readStdin: () => "not a pairing" }));
    assert.equal(envelope.code, "BAD_USAGE");
    assert.match(envelope.message, /nostr\+walletconnect/);
  });

  it("parses --max-sats as a positive whole number", () => {
    assert.equal(parseMaxSats("10500"), 10500);
    assert.equal(captureFail(() => parseMaxSats("0")).code, "BAD_FLAG");
    assert.equal(captureFail(() => parseMaxSats("1.5")).code, "BAD_FLAG");
  });
});
