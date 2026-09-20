import assert from "node:assert/strict";
import test from "node:test";
import { afterFaucet } from "./funded-payment.js";
import { X402BalanceError } from "./paid-fetch.js";
import { PaymentRequired } from "../errors.js";

const miss = () => new X402BalanceError("X402_INSUFFICIENT_FUNDS", "balance not visible", {});
function clock() {
  let time = 0;
  return { now: () => time, sleep: async (ms: number) => { time += ms; } };
}

test("confirmed faucet RPC lag retries preflight until balance becomes visible", async () => {
  let calls = 0;
  const timer = clock();
  const result = await afterFaucet(async () => {
    if (++calls < 4) throw miss();
    return "paid once";
  }, timer);
  assert.equal(result, "paid once");
  assert.equal(calls, 4);
  assert.equal(timer.now(), 3000);
});

test("faucet visibility wait is bounded and preserves the last structured error", async () => {
  const error = miss();
  const timer = clock();
  let calls = 0;
  await assert.rejects(afterFaucet(async () => { calls++; throw error; }, timer), e => e === error);
  assert.equal(timer.now(), 30_000);
  assert.equal(calls, 30);
});

test("never retries payment uncertainty, RPC failures, or an unproven balance miss", async () => {
  for (const error of [
    new Error("network failed after payment"),
    new X402BalanceError("X402_RPC_UNAVAILABLE", "RPC unavailable", {}),
    new X402BalanceError("X402_INSUFFICIENT_FUNDS", "started", { payment_started: true }),
    new PaymentRequired("unproven", 402, { code: "X402_INSUFFICIENT_FUNDS" }, "payment"),
    new PaymentRequired("unknown mutation", 402, {
      code: "X402_INSUFFICIENT_FUNDS", mutation_state: "unknown",
      details: { phase: "balance_preflight", payment_started: false },
    }, "payment"),
  ]) {
    let calls = 0;
    await assert.rejects(afterFaucet(async () => { calls++; throw error; }, clock()), e => e === error);
    assert.equal(calls, 1);
  }
});
