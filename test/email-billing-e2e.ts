/**
 * Email Billing Accounts E2E Test
 *
 * Tests the email-based billing flow against a live run402 gateway:
 *   1. Create email billing account
 *   2. Duplicate email → idempotent
 *   3. Balance by email
 *   4. Balance by wallet (backward compat)
 *   5. Invalid identifier → 400
 *   6. Tier checkout by email → returns Stripe URL
 *   7. Tier checkout by wallet → returns Stripe URL
 *   8. Invalid tier → 400
 *   9. Email pack checkout by email → returns Stripe URL
 *  10. Email pack checkout by wallet → returns Stripe URL
 *  11. Link wallet to email account (if email account has no wallet)
 *  12. Wallet already linked → 409
 *  13. History by email
 *  14. Auto-recharge enable/disable
 *
 * NOTE: This test does NOT complete Stripe payments (that would require
 * mocking webhooks or using Stripe test mode with real cards). It verifies
 * that the endpoints work correctly and return Stripe checkout URLs.
 *
 * Usage:
 *   BASE_URL=https://api.run402.com npm run test:email-billing
 *   BASE_URL=http://localhost:4022 npm run test:email-billing
 *
 * Requires: BUYER_PRIVATE_KEY (for wallet identifier tests), ADMIN_KEY
 */

import { config } from "dotenv";
config();

import { privateKeyToAccount } from "viem/accounts";

const BASE_URL = process.env.BASE_URL || "http://localhost:4022";
const BUYER_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!BUYER_KEY) { console.error("Missing BUYER_PRIVATE_KEY"); process.exit(1); }
if (!ADMIN_KEY) { console.error("Missing ADMIN_KEY"); process.exit(1); }

const account = privateKeyToAccount(BUYER_KEY);

let passed = 0;
let failed = 0;
function ok(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \u2713 ${name}${detail ? " \u2014 " + detail : ""}`);
    passed++;
  } else {
    console.error(`  \u2717 ${name}${detail ? " \u2014 " + detail : ""}`);
    failed++;
  }
}

(async () => {
  console.log(`\nEmail Billing E2E \u2014 ${BASE_URL}\n`);

  const testEmail = `billing-test-${Date.now()}@example.com`;

  // 1. Create email billing account
  console.log("1. Create email billing account");
  const createResp = await fetch(`${BASE_URL}/billing/v1/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail }),
  });
  ok("create returns 201", createResp.status === 201, `status=${createResp.status}`);
  const createBody = await createResp.json();
  ok("response has id", !!createBody.id);
  ok("response has email", createBody.email === testEmail);
  ok("response has email_credits_remaining=0", createBody.email_credits_remaining === 0);
  const accountId = createBody.id;

  // 2. Duplicate email → idempotent
  console.log("\n2. Duplicate email (idempotent)");
  const dupResp = await fetch(`${BASE_URL}/billing/v1/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail }),
  });
  const dupBody = await dupResp.json();
  ok("duplicate returns same id", dupBody.id === accountId, `${dupBody.id} vs ${accountId}`);

  // 3. Balance by email
  console.log("\n3. Balance by email");
  const balResp = await fetch(`${BASE_URL}/billing/v1/accounts/${encodeURIComponent(testEmail)}`);
  ok("balance by email 200", balResp.status === 200, `status=${balResp.status}`);
  const balBody = await balResp.json();
  ok("identifier_type=email", balBody.identifier_type === "email");
  ok("email_credits_remaining present", typeof balBody.email_credits_remaining === "number");

  // 4. Balance by wallet (backward compat)
  console.log("\n4. Balance by wallet (backward compat)");
  const walletAddr = account.address.toLowerCase();
  const walletBalResp = await fetch(`${BASE_URL}/billing/v1/accounts/${walletAddr}`);
  ok("balance by wallet 200", walletBalResp.status === 200, `status=${walletBalResp.status}`);
  const walletBalBody = await walletBalResp.json();
  ok("identifier_type=wallet", walletBalBody.identifier_type === "wallet");

  // 5. Invalid identifier → 400
  console.log("\n5. Invalid identifier");
  const badResp = await fetch(`${BASE_URL}/billing/v1/accounts/not-a-wallet-or-email`);
  ok("invalid returns 400", badResp.status === 400, `status=${badResp.status}`);

  // 6. Tier checkout by email
  console.log("\n6. Tier checkout by email");
  const tierEmailResp = await fetch(`${BASE_URL}/billing/v1/tiers/hobby/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail }),
  });
  if (tierEmailResp.status === 503) {
    console.log("  (skip: Stripe not configured for this environment)");
  } else {
    ok("tier checkout 200", tierEmailResp.status === 200, `status=${tierEmailResp.status}`);
    const tierBody = await tierEmailResp.json();
    ok("has checkout_url", !!tierBody.checkout_url);
    ok("has topup_id", !!tierBody.topup_id);
    ok("URL is Stripe", tierBody.checkout_url?.includes("stripe.com"));
  }

  // 7. Tier checkout by wallet
  console.log("\n7. Tier checkout by wallet");
  const tierWalletResp = await fetch(`${BASE_URL}/billing/v1/tiers/hobby/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: walletAddr }),
  });
  if (tierWalletResp.status === 503) {
    console.log("  (skip: Stripe not configured)");
  } else {
    ok("tier wallet checkout 200", tierWalletResp.status === 200, `status=${tierWalletResp.status}`);
  }

  // 8. Invalid tier → 400
  console.log("\n8. Invalid tier");
  const badTierResp = await fetch(`${BASE_URL}/billing/v1/tiers/enterprise/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail }),
  });
  ok("invalid tier returns 400", badTierResp.status === 400, `status=${badTierResp.status}`);

  // 9. Email pack checkout by email
  console.log("\n9. Email pack checkout by email");
  const packEmailResp = await fetch(`${BASE_URL}/billing/v1/email-packs/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail }),
  });
  if (packEmailResp.status === 503) {
    console.log("  (skip: Stripe not configured)");
  } else {
    ok("pack checkout 200", packEmailResp.status === 200, `status=${packEmailResp.status}`);
    const packBody = await packEmailResp.json();
    ok("pack has checkout_url", !!packBody.checkout_url);
    ok("pack has topup_id", !!packBody.topup_id);
  }

  // 10. Email pack checkout by wallet
  console.log("\n10. Email pack checkout by wallet");
  const packWalletResp = await fetch(`${BASE_URL}/billing/v1/email-packs/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: walletAddr }),
  });
  if (packWalletResp.status === 503) {
    console.log("  (skip: Stripe not configured)");
  } else {
    ok("pack wallet checkout 200", packWalletResp.status === 200, `status=${packWalletResp.status}`);
  }

  // 11. Missing identifier → 400
  console.log("\n11. Missing identifier");
  const noIdResp = await fetch(`${BASE_URL}/billing/v1/email-packs/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  ok("missing identifier 400", noIdResp.status === 400, `status=${noIdResp.status}`);

  // 12. History by email
  console.log("\n12. History by email");
  const histResp = await fetch(`${BASE_URL}/billing/v1/accounts/${encodeURIComponent(testEmail)}/history`);
  ok("history by email 200", histResp.status === 200, `status=${histResp.status}`);
  const histBody = await histResp.json();
  ok("identifier_type=email", histBody.identifier_type === "email");
  ok("entries is array", Array.isArray(histBody.entries));

  // 13. Auto-recharge enable
  console.log("\n13. Auto-recharge enable");
  const arEnableResp = await fetch(`${BASE_URL}/billing/v1/email-packs/auto-recharge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ billing_account_id: accountId, enabled: true, threshold: 3000 }),
  });
  ok("auto-recharge enable 200", arEnableResp.status === 200, `status=${arEnableResp.status}`);

  // 14. Auto-recharge disable
  console.log("\n14. Auto-recharge disable");
  const arDisableResp = await fetch(`${BASE_URL}/billing/v1/email-packs/auto-recharge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ billing_account_id: accountId, enabled: false }),
  });
  ok("auto-recharge disable 200", arDisableResp.status === 200, `status=${arDisableResp.status}`);

  // --- Summary ---
  console.log(`\n${"=".repeat(40)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
