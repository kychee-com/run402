import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "run402-stripe-cli-"));
const configDir = join(tempDir, "config");
const API = "https://test-api.run402.com";

process.env.RUN402_CONFIG_DIR = configDir;
process.env.RUN402_API_BASE = API;

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BASE = `${API}/projects/v1/prj_club/stripe`;
const ONBOARDING_URL = "https://connect.stripe.com/setup/s/one-time-secret-link";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const originalCwd = process.cwd();

let calls = [];
let stdout = [];
let stderr = [];
let run;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function account(overrides = {}) {
  return {
    org_id: "5f0a7c2e-6f0a-4a7e-9d1a-1a2b3c4d5e6f",
    scope: "organization",
    account_id: "acct_123",
    status: "onboarding",
    livemode: false,
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: false,
    requirements: { currently_due: ["external_account"], past_due: [], eventually_due: [], disabled_reason: null },
    capabilities: { card_payments: "pending", sepa_debit_payments: "pending" },
    country: "DE",
    default_currency: null,
    dashboard: "full",
    custody: "organization",
    platform_fee_bps: 0,
    created_at: "2026-10-15T08:00:00.000Z",
    updated_at: "2026-10-15T08:00:00.000Z",
    disconnected_at: null,
    next_actions: [{ type: "complete_onboarding", method: "POST", path: "/projects/v1/prj_club/stripe/onboarding-links" }],
    ...overrides,
  };
}

const USDC_BALANCE_HEX = "0x" + "0".repeat(58) + "03d090";

async function mockFetch(input, init) {
  const isRequest = input instanceof Request;
  const url = isRequest ? input.url : String(input);
  const method = ((isRequest ? input.method : init?.method) || "GET").toUpperCase();
  const rawBody = isRequest ? await input.clone().text() : init?.body;
  const body = rawBody ? JSON.parse(String(rawBody)) : null;
  const headers = Object.fromEntries(new Headers(isRequest ? input.headers : (init?.headers ?? {})).entries());
  if (!url.startsWith(API)) {
    return json({ jsonrpc: "2.0", id: body?.id ?? 1, result: USDC_BALANCE_HEX });
  }
  calls.push({ url, method, body, headers });

  if (url === `${BASE}/account` && method === "POST") {
    return json(account({ onboarding: { url: ONBOARDING_URL, expires_at: "2026-10-15T08:05:00.000Z", kind: "account_onboarding" } }), 201);
  }
  if (url === `${BASE}/account` && method === "GET") {
    return json(account());
  }
  if (url === `${BASE}/account` && method === "DELETE") {
    return json({ disconnected: true, account_id: "acct_123", stripe_account_unaffected: true, org_id: "5f0a7c2e-6f0a-4a7e-9d1a-1a2b3c4d5e6f", next_actions: [] });
  }
  if (url === `${BASE}/onboarding-links` && method === "POST") {
    return json({ url: ONBOARDING_URL, expires_at: "2026-10-15T08:05:00.000Z", kind: "account_update", account_id: "acct_123" }, 201);
  }
  if (url === `${BASE}/checkout-sessions` && method === "POST") {
    if (body.mode === "subscription" && !body.line_items[0].price_data?.recurring) {
      return json({ error: "VALIDATION_FAILED", code: "VALIDATION_FAILED", message: "recurring is required in mode subscription", details: { field: "line_items[0].price_data.recurring" } }, 422);
    }
    return json({
      checkout_session_id: "cs_test_1",
      url: "https://checkout.stripe.com/c/pay/cs_test_1",
      expires_at: "2026-10-16T08:00:00.000Z",
      mode: body.mode,
      account_id: "acct_123",
      project_id: "prj_club",
      status: "open",
      deduplicated: false,
      next_actions: [{ type: "poll", method: "GET", path: "/projects/v1/prj_club/stripe/checkout-sessions/cs_test_1" }],
    }, 201);
  }
  if (url === `${BASE}/checkout-sessions/cs_test_1` && method === "GET") {
    return json({ checkout_session_id: "cs_test_1", status: "complete", payment_status: "paid", mode: "subscription", customer_id: "cus_1", subscription_id: "sub_1", client_reference_id: "member:42", metadata: {} });
  }
  if (url === `${BASE}/portal-sessions` && method === "POST") {
    return json({ url: "https://billing.stripe.com/p/session/x" }, 201);
  }
  return json({ error: `unexpected ${method} ${url}` }, 500);
}

function captureStart() {
  stdout = [];
  stderr = [];
  console.log = (...args) => stdout.push(args.join(" "));
  console.error = (...args) => stderr.push(args.join(" "));
}

function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

async function runCaptured(sub, args) {
  captureStart();
  let threw = null;
  try {
    await run(sub, args);
  } catch (err) {
    threw = err;
  } finally {
    captureStop();
  }
  return { threw, out: stdout.join("\n"), err: stderr.join("\n") };
}

before(async () => {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "wallet.json"), JSON.stringify({ address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY }));
  process.chdir(tempDir);
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  ({ run } = await import("./cli/lib/stripe.mjs"));
});

after(() => {
  process.chdir(originalCwd);
  captureStop();
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  captureStop();
});

describe("run402 stripe account", () => {
  it("connect maps the prefill flags, prints the account with the link exactly once, and notes it on stderr", async () => {
    const { threw, out, err } = await runCaptured("account", [
      "connect", "--project", "prj_club", "--country", "DE", "--business-type", "non_profit", "--business-name", "Ruderverein", "--statement-descriptor", "RUDERVEREIN",
    ]);
    assert.equal(threw, null);
    assert.deepEqual(calls[0].body, { country: "DE", business_type: "non_profit", business_name: "Ruderverein", statement_descriptor: "RUDERVEREIN" });
    const printed = JSON.parse(out);
    assert.equal(printed.status, "onboarding");
    assert.equal(printed.onboarding.url, ONBOARDING_URL);
    assert.equal(out.split(ONBOARDING_URL).length - 1, 1, "the link appears exactly once on stdout");
    assert.ok(/shown ONCE/.test(err), `stderr should note the one-time link, got: ${err}`);
    assert.ok(!err.includes(ONBOARDING_URL), "stderr never repeats the link");
  });

  it("connect refuses an unknown business type before calling the gateway", async () => {
    const { threw, err } = await runCaptured("account", ["connect", "--project", "prj_club", "--business-type", "club"]);
    assert.equal(threw?.message, "process.exit(1)");
    assert.equal(calls.length, 0);
    assert.ok(/BAD_USAGE/.test(err));
  });

  it("status prints the account state and never a link", async () => {
    const { threw, out, err } = await runCaptured("account", ["status", "--project", "prj_club"]);
    assert.equal(threw, null);
    assert.equal(calls[0].method, "GET");
    const printed = JSON.parse(out);
    assert.equal(printed.status, "onboarding");
    assert.equal("onboarding" in printed, false);
    assert.ok(!out.includes("https://connect.stripe.com"), "status output contains no onboarding URL");
    assert.ok(!out.includes("https://checkout.stripe.com"), "status output contains no checkout URL");
    assert.equal(err, "");
  });

  it("onboarding-link maps the URLs and prints the link once", async () => {
    const { threw, out, err } = await runCaptured("account", [
      "onboarding-link", "--project", "prj_club", "--return-url", "https://club.run402.app/admin", "--refresh-url", "https://club.run402.app/admin?refresh=1",
    ]);
    assert.equal(threw, null);
    assert.deepEqual(calls[0].body, { return_url: "https://club.run402.app/admin", refresh_url: "https://club.run402.app/admin?refresh=1" });
    assert.equal(JSON.parse(out).kind, "account_update");
    assert.equal(out.split(ONBOARDING_URL).length - 1, 1);
    assert.ok(/shown ONCE/.test(err));
  });

  it("disconnect without --confirm refuses, names the flag, and does not call the gateway", async () => {
    const { threw, out, err } = await runCaptured("account", ["disconnect", "--project", "prj_club"]);
    assert.equal(threw?.message, "process.exit(1)");
    assert.equal(calls.length, 0);
    assert.equal(out, "");
    assert.ok(/CONFIRMATION_REQUIRED/.test(err), `stderr: ${err}`);
    assert.ok(/--confirm/.test(err));
  });

  it("disconnect --confirm detaches and reports the Stripe account unaffected", async () => {
    const { threw, out } = await runCaptured("account", ["disconnect", "--project", "prj_club", "--confirm"]);
    assert.equal(threw, null);
    assert.equal(calls[0].method, "DELETE");
    const printed = JSON.parse(out);
    assert.equal(printed.disconnected, true);
    assert.equal(printed.stripe_account_unaffected, true);
  });

  it("an unknown account action is UNKNOWN_SUBCOMMAND with the known leaves", async () => {
    const { threw, err } = await runCaptured("account", ["frobnicate", "--project", "prj_club"]);
    assert.equal(threw?.message, "process.exit(1)");
    const envelope = JSON.parse(err.split("\n").find((line) => line.startsWith("{")));
    assert.equal(envelope.code, "UNKNOWN_SUBCOMMAND");
    assert.deepEqual(envelope.details.known_subcommands, ["connect", "disconnect", "onboarding-link", "status"]);
  });
});

describe("run402 stripe checkout", () => {
  it("create builds the subscription line from --price-data, sends Idempotency-Key, and prints the session", async () => {
    const priceData = { currency: "eur", unit_amount: 12000, product_name: "Annual dues", recurring: { interval: "year" } };
    const { threw, out } = await runCaptured("checkout", [
      "create", "--project", "prj_club", "--mode", "subscription", "--price-data", JSON.stringify(priceData),
      "--success-url", "https://club.run402.app/join/done", "--cancel-url", "https://club.run402.app/join",
      "--customer-email", "ada@example.org", "--client-reference-id", "member:42", "--trial-days", "14", "--idempotency-key", "member:42:2026",
    ]);
    assert.equal(threw, null);
    assert.equal(calls[0].headers["idempotency-key"], "member:42:2026");
    assert.deepEqual(calls[0].body, {
      mode: "subscription",
      line_items: [{ price_data: priceData, quantity: 1 }],
      success_url: "https://club.run402.app/join/done",
      cancel_url: "https://club.run402.app/join",
      customer_email: "ada@example.org",
      client_reference_id: "member:42",
      subscription: { trial_period_days: 14 },
    });
    const printed = JSON.parse(out);
    assert.equal(printed.url, "https://checkout.stripe.com/c/pay/cs_test_1");
    assert.equal(printed.next_actions[0].type, "poll");
  });

  it("create with --price sends the price id and quantity", async () => {
    const { threw } = await runCaptured("checkout", [
      "create", "--project", "prj_club", "--mode", "payment", "--price", "price_123", "--quantity", "2",
      "--success-url", "https://club.run402.app/ok", "--cancel-url", "https://club.run402.app/no",
    ]);
    assert.equal(threw, null);
    assert.deepEqual(calls[0].body.line_items, [{ price: "price_123", quantity: 2 }]);
    assert.equal(calls[0].headers["idempotency-key"], undefined);
  });

  it("create refuses both --price and --price-data, and a bad --mode, locally", async () => {
    let r = await runCaptured("checkout", ["create", "--project", "prj_club", "--mode", "payment", "--price", "price_1", "--price-data", "{}", "--success-url", "https://a.run402.app/ok", "--cancel-url", "https://a.run402.app/no"]);
    assert.equal(r.threw?.message, "process.exit(1)");
    assert.ok(/exactly one of --price/.test(r.err));
    r = await runCaptured("checkout", ["create", "--project", "prj_club", "--mode", "donation", "--price", "price_1", "--success-url", "https://a.run402.app/ok", "--cancel-url", "https://a.run402.app/no"]);
    assert.equal(r.threw?.message, "process.exit(1)");
    assert.ok(/--mode must be/.test(r.err));
    assert.equal(calls.length, 0);
  });

  it("create surfaces the gateway's validation refusal unchanged", async () => {
    const { threw, err } = await runCaptured("checkout", [
      "create", "--project", "prj_club", "--mode", "subscription", "--price-data", '{"currency":"eur","unit_amount":100,"product_name":"x"}',
      "--success-url", "https://club.run402.app/ok", "--cancel-url", "https://club.run402.app/no",
    ]);
    assert.equal(threw?.message, "process.exit(1)");
    assert.ok(/VALIDATION_FAILED/.test(err));
    assert.ok(/line_items\[0\]\.price_data\.recurring/.test(err));
  });

  it("get reads the outcome", async () => {
    const { threw, out } = await runCaptured("checkout", ["get", "cs_test_1", "--project", "prj_club"]);
    assert.equal(threw, null);
    assert.equal(calls[0].url, `${BASE}/checkout-sessions/cs_test_1`);
    assert.equal(JSON.parse(out).payment_status, "paid");
  });
});

describe("run402 stripe portal", () => {
  it("create maps the customer and return URL", async () => {
    const { threw, out } = await runCaptured("portal", ["create", "--project", "prj_club", "--customer", "cus_1", "--return-url", "https://club.run402.app/account"]);
    assert.equal(threw, null);
    assert.deepEqual(calls[0].body, { customer: "cus_1", return_url: "https://club.run402.app/account" });
    assert.equal(JSON.parse(out).url, "https://billing.stripe.com/p/session/x");
  });

  it("create without the required flags refuses locally", async () => {
    const { threw, err } = await runCaptured("portal", ["create", "--project", "prj_club", "--customer", "cus_1"]);
    assert.equal(threw?.message, "process.exit(1)");
    assert.ok(/--return-url/.test(err));
    assert.equal(calls.length, 0);
  });
});
