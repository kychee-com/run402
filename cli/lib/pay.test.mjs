import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseUsdMicros, run } from "./pay.mjs";

describe("run402 pay", () => {
  it("converts decimal USD to micros without floating-point rounding", () => {
    assert.equal(parseUsdMicros("0.05"), 50_000);
    assert.equal(parseUsdMicros("1.000001"), 1_000_001);
    assert.equal(parseUsdMicros("0"), 0);
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
                amount_usd_micros: 10_000,
                pay_to: "0xseller",
                network: "eip155:8453",
                tx_ref: "0xtx",
                url,
              },
              outcome: "settled",
              replay: false,
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
    });
    assert.deepEqual(JSON.parse(output[0]), {
      http_status: 200,
      body: { translated: "hola" },
      payment: {
        amount_usd_micros: 10_000,
        pay_to: "0xseller",
        network: "eip155:8453",
        tx_ref: "0xtx",
        url: "https://seller.example/translate",
      },
      outcome: "settled",
      replay: false,
    });
  });
});
