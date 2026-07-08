import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("tenant x402 wallet-stats example", () => {
  it("keeps the route fixed-price at 3 cents", () => {
    const manifest = read("run402.deploy.ts");
    assert.match(manifest, /pattern:\s*"\/wallet-stats"/);
    assert.match(manifest, /methods:\s*\["POST"\]/);
    assert.match(manifest, /amount_usd_micros:\s*30_000/);
    assert.match(manifest, /pay_to:\s*"org_default_payout"/);
    assert.match(manifest, /networks:\s*\["testnet"\]/);
    assert.match(manifest, /expect:\s*\{\s*status:\s*402\s*\}/);
  });

  it("sends settled wallet stats to the requested mailbox", () => {
    const fn = read("functions/wallet-stats.js");
    assert.match(fn, /major\.tal@gmail\.com/);
    assert.match(fn, /getRoutedPaymentContext\(req\)/);
    assert.match(fn, /email\.send\(/);
    assert.match(fn, /payment\.payer/);
    assert.match(fn, /payment\.payTo/);
    assert.match(fn, /EXPECTED_AMOUNT_USD_MICROS\s*=\s*30_000/);
  });

  it("uses x402 paid fetch for the agent call", () => {
    const script = read("scripts/call-paid-wallet-stats.mjs");
    assert.match(script, /wrapFetchWithPayment/);
    assert.match(script, /NodeCredentialsProvider/);
    assert.match(script, /\["wallets",\s*"current",\s*"--json"\]/);
    assert.match(script, /process\.env\.RUN402_WALLET\s*=\s*profile/);
    assert.match(script, /BUYER_PRIVATE_KEY/);
    assert.match(script, /X402_NETWORK\s*\|\|\s*"eip155:84532"/);
    assert.match(script, /fetchPaid\(url/);
  });
});
