/**
 * `run402 redeem` + `run402 init --voucher` behavior.
 *
 * The load-bearing invariant here is the SECOND one: a voucher must never take
 * init down with it. A human pastes a prompt carrying a promo code, an agent
 * runs one command, and if that command exits non-zero because the code was
 * expired, the agent is left un-provisioned and blames the platform. The gift
 * is a bonus; setup is the job. So every redemption failure — bad code,
 * expired, claimed elsewhere, org at its ceiling, network down, gateway too old
 * to know the route — must warn, record `voucher_error`, and let init finish.
 */

import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const originalConfigDir = process.env.RUN402_CONFIG_DIR;

let stdout = [];
let stderr = [];
let redeemCalls = [];
let redeemImpl = async () => ({});

const REDEEMED = {
  voucher_id: "11111111-1111-1111-1111-111111111111",
  amount_usd_micros: 1_000_000,
  balance_usd_micros: 1_000_000,
  organization_id: "22222222-2222-2222-2222-222222222222",
  redeemed_at: "2026-08-09T20:00:00.000Z",
  already_redeemed: false,
  promo_lifetime_ceiling_usd_micros: 1_000_000,
  next_actions: [{ type: "set_tier", cli: "run402 tier set prototype", why: "The credit covers it." }],
};

// Mock the chain layer. Without this, init reads a real Base Sepolia balance,
// finds 0, and then polls for 30 seconds per case — turning a unit test into a
// two-hundred-second network-dependent one. A funded balance short-circuits
// straight past the faucet to the step under test.
mock.module("viem", {
  namedExports: {
    createPublicClient: () => ({ readContract: async () => 5_000_000n }),
    http: () => ({}),
    defineChain: (c) => c,
  },
});
mock.module("viem/chains", { namedExports: { baseSepolia: { id: 84532 } } });
mock.module("viem/accounts", {
  namedExports: {
    generatePrivateKey: () => "0x" + "11".repeat(32),
    privateKeyToAccount: () => ({ address: "0x1111111111111111111111111111111111111111" }),
  },
});

mock.module("./cli/lib/sdk.mjs", {
  namedExports: {
    getSdk: () => ({
      vouchers: {
        redeem: (code) => {
          redeemCalls.push(code);
          return redeemImpl(code);
        },
      },
      // init's other reads — kept deliberately boring so the test isolates the
      // voucher step rather than re-testing setup.
      billing: { checkBalance: async () => null },
      tier: { status: async () => null },
      allowance: { faucet: async () => ({}) },
    }),
  },
});

function captureStart() {
  stdout = [];
  stderr = [];
  console.log = (...a) => stdout.push(a.map(String).join(" "));
  console.error = (...a) => stderr.push(a.map(String).join(" "));
}
function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

let tmpDir;
beforeEach(() => {
  redeemCalls = [];
  redeemImpl = async () => REDEEMED;
  tmpDir = mkdtempSync(join(tmpdir(), "run402-redeem-"));
  process.env.RUN402_CONFIG_DIR = tmpDir;
  process.exit = (code) => {
    throw new Error(`process.exit(${code})`);
  };
});
afterEach(() => {
  captureStop();
  process.exit = originalExit;
  if (originalConfigDir === undefined) delete process.env.RUN402_CONFIG_DIR;
  else process.env.RUN402_CONFIG_DIR = originalConfigDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("run402 redeem", () => {
  it("sends the code verbatim and prints the result as JSON on stdout", async () => {
    const { run } = await import("./cli/lib/redeem.mjs");
    captureStart();
    await run(["R402-K8F3-Q2W9"]);
    captureStop();

    assert.deepEqual(redeemCalls, ["R402-K8F3-Q2W9"]);
    const parsed = JSON.parse(stdout.join("\n"));
    assert.equal(parsed.amount_usd_micros, 1_000_000);
    // The pipe contract: the payload is stdout, the human-readable progress is
    // stderr. A summary line on stdout would break `| jq`.
    assert.match(stderr.join("\n"), /Voucher\s+\$1\.00 credited/);
    assert.match(stderr.join("\n"), /run402 tier set prototype/);
  });

  it("renders a replay honestly instead of as a fresh credit", async () => {
    redeemImpl = async () => ({ ...REDEEMED, already_redeemed: true });
    const { run } = await import("./cli/lib/redeem.mjs");
    captureStart();
    await run(["R402-K8F3-Q2W9"]);
    captureStop();
    assert.match(stderr.join("\n"), /already redeemed/i);
    assert.equal(JSON.parse(stdout.join("\n")).already_redeemed, true);
  });

  it("fails usage (not a network call) when the code is missing", async () => {
    const { run } = await import("./cli/lib/redeem.mjs");
    captureStart();
    await assert.rejects(() => run([]), /process\.exit/);
    captureStop();
    assert.equal(redeemCalls.length, 0);
    // `fail()` writes the error envelope to stderr; stdout stays clean so a
    // piped consumer never parses an error as a payload.
    assert.match(stderr.join("\n"), /BAD_USAGE/);
    assert.equal(stdout.join("\n"), "");
  });
});

describe("run402 init --voucher", () => {
  it("parses the flag in both spellings and redeems the code", async () => {
    const { run } = await import("./cli/lib/init.mjs");
    for (const argv of [["--voucher", "R402-AAAA-BBBB"], ["--voucher=R402-AAAA-BBBB"]]) {
      redeemCalls = [];
      captureStart();
      await run(argv).catch(() => {});
      captureStop();
      assert.deepEqual(redeemCalls, ["R402-AAAA-BBBB"], `argv ${argv.join(" ")}`);
    }
  });

  it("NEVER fails init when redemption fails — warns and records voucher_error", async () => {
    // Every failure shape an agent can actually hit in the wild.
    const failures = [
      Object.assign(new Error("That voucher has expired."), { body: { code: "VOUCHER_EXPIRED" } }),
      Object.assign(new Error("That voucher code is not valid."), { body: { code: "VOUCHER_NOT_FOUND" } }),
      Object.assign(new Error("fetch failed"), {}),
    ];
    const { run } = await import("./cli/lib/init.mjs");
    for (const failure of failures) {
      redeemImpl = async () => {
        throw failure;
      };
      captureStart();
      let threw = null;
      try {
        await run(["--voucher", "R402-DEAD-BEEF"]);
      } catch (err) {
        threw = err;
      }
      captureStop();

      assert.equal(threw, null, `init must not throw on ${failure.body?.code ?? "network error"}`);
      const summary = JSON.parse(stdout.join("\n"));
      assert.equal(summary.voucher, null);
      assert.ok(summary.voucher_error, "the failure is named, not silently dropped");
      assert.match(stderr.join("\n"), /Voucher\s+not applied/);
      // Setup still happened: the summary is a complete init summary.
      assert.ok(summary.config_dir, "init still reports its config dir");
      assert.ok(summary.wallet, "init still provisioned a wallet");
    }
  });

  it("omits the voucher fields entirely when no code was offered", async () => {
    // Absence must mean "no code was given", never "a code vanished".
    const { run } = await import("./cli/lib/init.mjs");
    captureStart();
    await run([]).catch(() => {});
    captureStop();
    const summary = JSON.parse(stdout.join("\n"));
    assert.equal("voucher" in summary, false);
    assert.equal("voucher_error" in summary, false);
    assert.equal(redeemCalls.length, 0);
  });
});
