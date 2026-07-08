import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    assert.match(manifest, /tenant-x402-wallet-stats-20260708/);
    assert.match(manifest, /static\/index\.html/);
    assert.doesNotMatch(manifest, /\bchecks\s*:/);
  });

  it("accepts route pricing in deploy manifest normalization", () => {
    const output = execFileSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
        import { normalizeDeployManifest } from "../../sdk/src/node/deploy-manifest.ts";
        const out = await normalizeDeployManifest({
          project: "prj_test",
          routes: {
            replace: [{
              pattern: "/wallet-stats",
              methods: ["POST"],
              target: { type: "function", name: "wallet_stats" },
              pricing: {
                mode: "always",
                amount_usd_micros: 30_000,
                pay_to: "org_default_payout",
                networks: ["testnet"],
              },
            }],
          },
        });
        console.log(JSON.stringify(out.spec.routes.replace[0].pricing));
      `,
    ], { cwd: ROOT, encoding: "utf8" });
    const parsed = JSON.parse(output);
    assert.equal(parsed.amount_usd_micros, 30_000);
    assert.deepEqual(parsed.networks, ["testnet"]);
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
