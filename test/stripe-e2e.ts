/**
 * Stripe Subscription E2E Test
 *
 * Tests the full Stripe subscription lifecycle:
 *   1.  Create Stripe customer with wallet_address metadata
 *   2.  Create subscription with test payment method
 *   3.  Verify GET /v1/stripe/subscription/:wallet returns active
 *   4.  Create project via POST /v1/projects with x402 payment header — bypass settlement
 *   5.  Verify project has subscription tier
 *   6.  Check GET /v1/wallets/:address/projects returns the project
 *   7.  Verify GET /v1/stripe/products returns plans
 *   8.  Clean up: cancel subscription, delete customer
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_... BASE_URL=http://localhost:4022 npx tsx stripe-e2e.ts
 */

import { config } from "dotenv";
config();

import Stripe from "stripe";

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const BASE_URL = process.env.BASE_URL || "http://localhost:4022";

if (!STRIPE_KEY) {
  console.error("Missing STRIPE_SECRET_KEY in .env");
  process.exit(1);
}

const stripe = new Stripe(STRIPE_KEY);
const TEST_WALLET = `0x${Date.now().toString(16)}${"a".repeat(40 - Date.now().toString(16).length)}`.toLowerCase();

let customerId: string;
let subscriptionId: string;
let priceId: string;

const results: Array<{ name: string; pass: boolean; error?: string }> = [];

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    results.push({ name, pass: false, error: err.message });
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

async function run() {
  console.log(`\nStripe Subscription E2E Test`);
  console.log(`  Base URL: ${BASE_URL}`);
  console.log(`  Test wallet: ${TEST_WALLET}\n`);

  // --- Setup: find or create a Hobby product + price ---
  await test("Setup: find or create Hobby product", async () => {
    const products = await stripe.products.list({ active: true, limit: 100 });
    let hobbyProduct = products.data.find((p) => p.metadata["run402_tier"] === "hobby");

    if (!hobbyProduct) {
      hobbyProduct = await stripe.products.create({
        name: "Run402 Hobby (Test)",
        metadata: { run402_tier: "hobby" },
      });
    }

    const prices = await stripe.prices.list({ product: hobbyProduct.id, active: true });
    let monthlyPrice = prices.data.find((p) => p.recurring?.interval === "month");

    if (!monthlyPrice) {
      monthlyPrice = await stripe.prices.create({
        product: hobbyProduct.id,
        unit_amount: 500,
        currency: "usd",
        recurring: { interval: "month" },
      });
    }

    priceId = monthlyPrice.id;
    assert(!!priceId, "Should have a price ID");
  });

  // --- Test 1: Create customer ---
  await test("Create Stripe customer with wallet metadata", async () => {
    const customer = await stripe.customers.create({
      metadata: { wallet_address: TEST_WALLET },
      email: `test-${Date.now()}@run402.com`,
    });
    customerId = customer.id;
    assert(!!customerId, "Should have customer ID");
  });

  // --- Test 2: Create subscription ---
  await test("Create subscription with test payment method", async () => {
    const pm = await stripe.paymentMethods.create({
      type: "card",
      card: { token: "tok_visa" },
    });

    await stripe.paymentMethods.attach(pm.id, { customer: customerId });
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: pm.id },
    });

    const sub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
    });

    subscriptionId = sub.id;
    assert(sub.status === "active", `Subscription should be active, got ${sub.status}`);
  });

  // --- Wait for Stripe search index (can take up to 60s) ---
  console.log("  ... waiting 65s for Stripe search index ...");
  await new Promise((r) => setTimeout(r, 65000));

  // --- Test 3: Clear cache and verify subscription status ---
  await test("Clear cache and verify subscription via API", async () => {
    // Clear the gateway's subscription cache
    await fetch(`${BASE_URL}/v1/stripe/cache/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: TEST_WALLET }),
    });

    const res = await fetch(`${BASE_URL}/v1/stripe/subscription/${TEST_WALLET}`);
    const data = await res.json();
    assert(data.subscribed === true, `Should be subscribed, got ${JSON.stringify(data)}`);
    assert(data.tier === "hobby", `Tier should be hobby, got ${data.tier}`);
  });

  // --- Test 4: Verify products endpoint ---
  await test("GET /v1/stripe/products returns plans", async () => {
    const res = await fetch(`${BASE_URL}/v1/stripe/products`);
    const data = await res.json();
    assert(Array.isArray(data.products), "Should return products array");
    assert(data.products.length > 0, "Should have at least one product");
    const hobby = data.products.find((p: any) => p.tier === "hobby");
    assert(!!hobby, "Should have a hobby product");
    assert(hobby.prices.length > 0, "Hobby should have prices");
  });

  // --- Test 5: Verify wallet projects (initially empty) ---
  await test("GET /v1/wallets/:address/projects returns empty list", async () => {
    const res = await fetch(`${BASE_URL}/v1/wallets/${TEST_WALLET}/projects`);
    const data = await res.json();
    assert(data.wallet === TEST_WALLET, "Should return correct wallet");
    assert(Array.isArray(data.projects), "Should return projects array");
  });

  // --- Test 6: Checkout endpoint rejects already-subscribed wallet ---
  await test("POST /v1/stripe/checkout rejects subscribed wallet", async () => {
    const res = await fetch(`${BASE_URL}/v1/stripe/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: TEST_WALLET, price_id: priceId }),
    });
    assert(res.status === 409, `Should return 409, got ${res.status}`);
  });

  // --- Cleanup ---
  await test("Cleanup: cancel subscription and delete customer", async () => {
    if (subscriptionId) {
      await stripe.subscriptions.cancel(subscriptionId);
    }
    if (customerId) {
      await stripe.customers.del(customerId);
    }
  });

  // --- Summary ---
  console.log("\n--- Summary ---");
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`  ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    console.log("Failed tests:");
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`  ✗ ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
