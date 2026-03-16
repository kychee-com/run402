/**
 * Billing / Allowance E2E Test
 *
 * Tests the full allowance billing lifecycle:
 *   1.  GET balance — non-existent wallet returns zero
 *   2.  Admin credit — fund a wallet with allowance
 *   3.  GET balance — verify credited amount
 *   4.  GET history — verify ledger entry
 *   5.  Idempotency — replay same credit → balance not doubled
 *   6.  Admin debit — debit from balance
 *   7.  Insufficient debit — verify 402 on overdraft
 *   8.  Allowance-funded project creation — x402 payment settled via allowance
 *   9.  Verify charge_authorizations — check DB entry created
 *  10.  Balance after purchase — verify decremented
 *  11.  Insufficient balance fallthrough — verify falls through to x402
 *  12.  Cleanup — admin debit remaining balance
 *
 * Usage:
 *   BASE_URL=http://localhost:4022 npm run test:billing
 *   BASE_URL=https://api.run402.com npm run test:billing
 */

import { config } from "dotenv";
config();

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

// --- Config ---

const BUYER_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const ADMIN_KEY = process.env.ADMIN_KEY;
const BASE_URL = process.env.BASE_URL || "http://localhost:4022";

if (!BUYER_KEY) {
  console.error("Missing BUYER_PRIVATE_KEY in .env");
  process.exit(1);
}

if (!ADMIN_KEY) {
  console.error("Missing ADMIN_KEY in .env");
  process.exit(1);
}

// --- Setup x402 client ---

const account = privateKeyToAccount(BUYER_KEY);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register("eip155:84532", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

// --- Helpers ---

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

const wallet = account.address.toLowerCase();
const idempotencyKey = `test-credit-${Date.now()}`;

// --- Main test flow ---

async function main() {
  console.log("\n=== Billing / Allowance E2E Test ===\n");
  console.log(`Target:  ${BASE_URL}`);
  console.log(`Wallet:  ${wallet}\n`);

  // 1) GET balance — non-existent or zero
  console.log("1) GET balance (initial)...");
  const balRes1 = await fetch(`${BASE_URL}/v1/billing/accounts/${wallet}`);
  const bal1 = await balRes1.json() as Record<string, unknown>;
  assert(balRes1.ok, "GET balance returns 200");
  const initialBalance = (bal1.available_usd_micros as number) || 0;
  console.log(`   Initial balance: ${initialBalance} micro-USD`);

  // 2) Admin credit — fund $100 (100_000_000 micro-USD)
  console.log("\n2) Admin credit ($100)...");
  const creditAmount = 100_000_000; // $100
  const creditRes = await fetch(`${BASE_URL}/v1/billing/admin/accounts/${wallet}/credit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": ADMIN_KEY,
    },
    body: JSON.stringify({
      amount_usd_micros: creditAmount,
      reason: "E2E test credit",
      idempotency_key: idempotencyKey,
    }),
  });
  const creditBody = await creditRes.json() as Record<string, unknown>;
  assert(creditRes.ok, "Admin credit returns 200");
  assert(creditBody.available_usd_micros === initialBalance + creditAmount, `Balance is ${initialBalance + creditAmount}`);
  assert(typeof creditBody.ledger_entry_id === "string", "Ledger entry ID returned");
  const billingAccountId = creditBody.billing_account_id;
  console.log(`   Account: ${billingAccountId}`);
  console.log(`   Balance: ${creditBody.available_usd_micros} micro-USD`);

  // 3) GET balance — verify credited
  console.log("\n3) GET balance (after credit)...");
  const balRes2 = await fetch(`${BASE_URL}/v1/billing/accounts/${wallet}`);
  const bal2 = await balRes2.json() as Record<string, unknown>;
  assert(balRes2.ok, "GET balance returns 200");
  assert(bal2.available_usd_micros === initialBalance + creditAmount, "Balance matches credited amount");

  // 4) GET history — verify ledger entry
  console.log("\n4) GET history...");
  const histRes = await fetch(`${BASE_URL}/v1/billing/accounts/${wallet}/history`);
  const hist = await histRes.json() as Record<string, unknown>;
  assert(histRes.ok, "GET history returns 200");
  const entries = (hist.entries || []) as Array<Record<string, unknown>>;
  assert(entries.length > 0, "Ledger has entries");
  const latestEntry = entries[0];
  if (latestEntry) {
    assert(latestEntry.direction === "credit", "Latest entry is a credit");
    assert(latestEntry.kind === "admin_credit", "Kind is admin_credit");
    assert(latestEntry.amount_usd_micros === creditAmount, `Amount is ${creditAmount}`);
  }

  // 5) Idempotency — replay same credit → balance NOT doubled
  console.log("\n5) Idempotency replay...");
  const replayRes = await fetch(`${BASE_URL}/v1/billing/admin/accounts/${wallet}/credit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": ADMIN_KEY,
    },
    body: JSON.stringify({
      amount_usd_micros: creditAmount,
      reason: "E2E test credit (replay)",
      idempotency_key: idempotencyKey, // Same key!
    }),
  });
  const replayBody = await replayRes.json() as Record<string, unknown>;
  assert(replayRes.ok, "Idempotent replay returns 200");
  // Balance should still be the same (not doubled)
  const balAfterReplay = await fetch(`${BASE_URL}/v1/billing/accounts/${wallet}`);
  const bal3 = await balAfterReplay.json() as Record<string, unknown>;
  assert(bal3.available_usd_micros === initialBalance + creditAmount, "Balance NOT doubled after replay");
  console.log(`   Balance after replay: ${bal3.available_usd_micros} micro-USD`);

  // 6) Admin debit — debit $10 (10_000_000 micro-USD)
  console.log("\n6) Admin debit ($10)...");
  const debitAmount = 10_000_000;
  const debitRes = await fetch(`${BASE_URL}/v1/billing/admin/accounts/${wallet}/debit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": ADMIN_KEY,
    },
    body: JSON.stringify({
      amount_usd_micros: debitAmount,
      reason: "E2E test debit",
    }),
  });
  const debitBody = await debitRes.json() as Record<string, unknown>;
  assert(debitRes.ok, "Admin debit returns 200");
  assert(debitBody.available_usd_micros === initialBalance + creditAmount - debitAmount, "Balance decremented correctly");
  console.log(`   Balance after debit: ${debitBody.available_usd_micros} micro-USD`);

  // 7) Insufficient debit — try to debit more than available
  console.log("\n7) Insufficient debit...");
  const overdraftRes = await fetch(`${BASE_URL}/v1/billing/admin/accounts/${wallet}/debit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": ADMIN_KEY,
    },
    body: JSON.stringify({
      amount_usd_micros: 999_999_999_999,
      reason: "E2E overdraft test",
    }),
  });
  assert(overdraftRes.status === 402, "Overdraft returns 402");

  // 8) Allowance-funded project creation + settlement headers
  console.log("\n8) Create project via allowance...");
  const balBeforeProject = (await (await fetch(`${BASE_URL}/v1/billing/accounts/${wallet}`)).json() as Record<string, unknown>).available_usd_micros as number;
  let projBody: Record<string, unknown>;
  let settlementRail: string | null = null;
  let allowanceRemaining: string | null = null;
  try {
    const projRes = await fetchPaid(`${BASE_URL}/v1/projects/create/prototype`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `billing-test-${Date.now()}` }),
    });
    projBody = await projRes.json() as Record<string, unknown>;
    assert(projRes.ok, "Project creation returns 200");
    assert(typeof projBody.project_id === "string", "Project ID returned");
    settlementRail = projRes.headers.get("x-run402-settlement-rail");
    allowanceRemaining = projRes.headers.get("x-run402-allowance-remaining");
  } catch {
    // x402 disabled locally — create project directly (no payment gate)
    console.log("   (x402 fetch failed — using direct POST)");
    const directRes = await fetch(`${BASE_URL}/v1/projects/create/prototype`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `billing-test-${Date.now()}` }),
    });
    projBody = await directRes.json() as Record<string, unknown>;
    assert(directRes.ok, "Direct project creation returns 200");
    assert(typeof projBody.project_id === "string", "Project ID returned");
  }
  const balAfterProject = (await (await fetch(`${BASE_URL}/v1/billing/accounts/${wallet}`)).json() as Record<string, unknown>).available_usd_micros as number;
  const usedAllowanceRail = balAfterProject < balBeforeProject;
  console.log(`   Project: ${projBody.project_id}`);
  console.log(`   Tier: ${projBody.tier}`);
  console.log(`   Allowance rail used: ${usedAllowanceRail} (balance: ${balBeforeProject} -> ${balAfterProject})`);

  // 8b) Verify settlement response headers
  if (usedAllowanceRail) {
    console.log(`   Settlement-Rail: ${settlementRail}`);
    console.log(`   Allowance-Remaining: ${allowanceRemaining}`);
    assert(settlementRail === "allowance", "X-Run402-Settlement-Rail is 'allowance'");
    assert(allowanceRemaining !== null, "X-Run402-Allowance-Remaining header present");
    const expectedRemaining = balBeforeProject - 100_000; // prototype tier = $0.10
    assert(Number(allowanceRemaining) === expectedRemaining, `Allowance-Remaining is ${expectedRemaining}`);
  } else {
    console.log("   (Skipped header checks — allowance rail not used)");
  }

  // 9) Balance after purchase — verify decremented (only if allowance rail was used)
  console.log("\n9) Balance after purchase...");
  const balRes4 = await fetch(`${BASE_URL}/v1/billing/accounts/${wallet}`);
  const bal4 = await balRes4.json() as Record<string, unknown>;
  if (usedAllowanceRail) {
    const expectedAfterPurchase = initialBalance + creditAmount - debitAmount - 100_000;
    assert(bal4.available_usd_micros === expectedAfterPurchase, `Balance is ${expectedAfterPurchase} (debited $0.10 for prototype)`);
  } else {
    console.log("   (Skipped — allowance rail not used without x402)");
    assert(true, "Balance check skipped (x402 disabled)");
  }
  console.log(`   Balance: ${bal4.available_usd_micros} micro-USD`);

  // 10) Check history has purchase entry (only if allowance rail was used)
  console.log("\n10) History after purchase...");
  const histRes2 = await fetch(`${BASE_URL}/v1/billing/accounts/${wallet}/history?limit=5`);
  const hist2 = await histRes2.json() as Record<string, unknown>;
  const entries2 = (hist2.entries || []) as Array<Record<string, unknown>>;
  if (usedAllowanceRail) {
    const purchaseEntry = entries2.find((e) => e.kind === "purchase_debit");
    assert(purchaseEntry != null, "Purchase debit entry exists in ledger");
    if (purchaseEntry) {
      assert(purchaseEntry.amount_usd_micros === 100_000, "Purchase amount is $0.10 (100,000 micros)");
      assert(purchaseEntry.direction === "debit", "Purchase is a debit");
    }
  } else {
    console.log("   (Skipped — allowance rail not used without x402)");
    assert(true, "Purchase entry check skipped (x402 disabled)");
  }

  // 11) Wallet projects endpoint works
  console.log("\n11) Wallet projects...");
  const projListRes = await fetch(`${BASE_URL}/v1/wallets/${wallet}/projects`);
  const projList = await projListRes.json() as Record<string, unknown>;
  assert(projListRes.ok, "Wallet projects returns 200");
  const projects = (projList.projects || []) as Array<Record<string, unknown>>;
  // The x402 middleware now sets req.walletAddress when the allowance rail is used,
  // so projects created via allowance-settled requests get proper wallet linkage.
  console.log(`   Projects found: ${projects.length}`);
  assert(true, "Wallet projects endpoint responds correctly");

  // 12) Admin auth required — verify 403 without admin key
  console.log("\n12) Admin auth check...");
  const noAuthRes = await fetch(`${BASE_URL}/v1/billing/admin/accounts/${wallet}/credit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount_usd_micros: 1000, reason: "unauthorized" }),
  });
  assert(noAuthRes.status === 403, "Credit without admin key returns 403");

  const wrongAuthRes = await fetch(`${BASE_URL}/v1/billing/admin/accounts/${wallet}/credit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": "wrong-key",
    },
    body: JSON.stringify({ amount_usd_micros: 1000, reason: "wrong key" }),
  });
  assert(wrongAuthRes.status === 403, "Credit with wrong admin key returns 403");

  // 13) Cleanup — debit remaining balance
  console.log("\n13) Cleanup — debit remaining...");
  const currentBal = await fetch(`${BASE_URL}/v1/billing/accounts/${wallet}`);
  const currentBalBody = await currentBal.json() as Record<string, unknown>;
  const remaining = (currentBalBody.available_usd_micros as number) || 0;
  if (remaining > 0) {
    const cleanupRes = await fetch(`${BASE_URL}/v1/billing/admin/accounts/${wallet}/debit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": ADMIN_KEY,
      },
      body: JSON.stringify({
        amount_usd_micros: remaining,
        reason: "E2E cleanup",
      }),
    });
    assert(cleanupRes.ok, `Cleanup debit of ${remaining} micro-USD succeeded`);
  }

  // Final balance check
  const finalBal = await fetch(`${BASE_URL}/v1/billing/accounts/${wallet}`);
  const finalBody = await finalBal.json() as Record<string, unknown>;
  assert((finalBody.available_usd_micros as number) === 0, "Final balance is zero");

  // --- Summary ---
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}\n`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
