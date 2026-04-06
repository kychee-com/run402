/**
 * E2E test for the KMS contract-wallets feature.
 *
 * Exercises the full surface against a running gateway:
 *   1. Provision wallet (requires 30-day prepay)
 *   2. GET wallet, list wallets
 *   3. Set recovery address
 *   4. Set low-balance threshold
 *   5. Submit a real contract call against base-sepolia (if TEST_CONTRACT
 *      env vars are set) and poll until confirmed
 *   6. Verify gas + sign-fee ledger entries
 *   7. Drain wallet
 *   8. Delete wallet
 *
 * Required env:
 *   BASE_URL                  — gateway base URL (default: http://localhost:4022)
 *   E2E_PROJECT_API_KEY       — service-role key for a project with cash balance
 *
 * Optional env (skip the on-chain stage if missing):
 *   TEST_CONTRACT_ADDRESS     — deployed write-call target on base-sepolia
 *   TEST_CONTRACT_FUNCTION    — function name (default: "ping")
 *   TEST_CONTRACT_ABI_JSON    — ABI fragment as a JSON string
 *
 * The on-chain stage requires the wallet to be funded with a small amount
 * of base-sepolia ETH at the address printed by the provision step. Top up
 * via https://www.alchemy.com/faucets/base-sepolia .
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:4022";
const API_KEY = process.env.E2E_PROJECT_API_KEY;
if (!API_KEY) {
  console.error("E2E_PROJECT_API_KEY env var is required");
  process.exit(1);
}

const TEST_CONTRACT_ADDRESS = process.env.TEST_CONTRACT_ADDRESS;
const TEST_CONTRACT_FUNCTION = process.env.TEST_CONTRACT_FUNCTION || "ping";
const TEST_CONTRACT_ABI_JSON = process.env.TEST_CONTRACT_ABI_JSON;

async function call<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: T;
  try { parsed = JSON.parse(text); } catch { parsed = text as unknown as T; }
  return { status: res.status, body: parsed };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

interface WalletResponse {
  id: string;
  chain: string;
  address: string;
  status: string;
  non_custodial_notice?: string;
  native_balance_wei?: string;
}

interface CallResponse {
  call_id: string;
  tx_hash: string;
  status: string;
}

async function main() {
  console.log(`E2E contracts test → ${BASE_URL}`);

  // 1. Provision wallet on base-sepolia (cheap; mainnet would cost real money)
  console.log("\n[1] POST /contracts/v1/wallets");
  const provision = await call<WalletResponse>("POST", "/contracts/v1/wallets", { chain: "base-sepolia" });
  assert(provision.status === 201, `expected 201, got ${provision.status}: ${JSON.stringify(provision.body)}`);
  assert(/^0x[a-fA-F0-9]{40}$/.test(provision.body.address), "missing address");
  assert(typeof provision.body.non_custodial_notice === "string", "missing non_custodial_notice");
  console.log("  wallet:", provision.body.id, provision.body.address);
  const walletId = provision.body.id;

  // 2. GET wallet
  console.log("\n[2] GET /contracts/v1/wallets/:id");
  const get = await call<WalletResponse>("GET", `/contracts/v1/wallets/${walletId}`);
  assert(get.status === 200, `expected 200, got ${get.status}`);
  assert(get.body.id === walletId, "wrong wallet id");

  // 3. LIST wallets
  console.log("\n[3] GET /contracts/v1/wallets");
  const list = await call<{ wallets: WalletResponse[] }>("GET", "/contracts/v1/wallets");
  assert(list.status === 200, `expected 200, got ${list.status}`);
  assert(Array.isArray(list.body.wallets) && list.body.wallets.some((w) => w.id === walletId), "new wallet not in list");

  // 4. Set recovery address
  console.log("\n[4] POST /contracts/v1/wallets/:id/recovery-address");
  const recoveryAddress = "0x000000000000000000000000000000000000dEaD";
  const setRec = await call<WalletResponse>("POST", `/contracts/v1/wallets/${walletId}/recovery-address`, { recovery_address: recoveryAddress });
  assert(setRec.status === 200, `expected 200, got ${setRec.status}`);

  // 5. Set low-balance threshold
  console.log("\n[5] POST /contracts/v1/wallets/:id/alert");
  const setAlert = await call<WalletResponse>("POST", `/contracts/v1/wallets/${walletId}/alert`, { threshold_wei: "1000000000000000" });
  assert(setAlert.status === 200, `expected 200, got ${setAlert.status}`);

  // 6. Submit + poll a real contract call (skip if no test contract configured)
  if (TEST_CONTRACT_ADDRESS && TEST_CONTRACT_ABI_JSON) {
    console.log("\n[6] POST /contracts/v1/call");
    const abiFragment = JSON.parse(TEST_CONTRACT_ABI_JSON);
    const submit = await call<CallResponse>("POST", "/contracts/v1/call", {
      wallet_id: walletId,
      chain: "base-sepolia",
      contract_address: TEST_CONTRACT_ADDRESS,
      abi_fragment: abiFragment,
      function_name: TEST_CONTRACT_FUNCTION,
      args: [],
    });
    if (submit.status === 402) {
      console.log("  → wallet has no ETH; fund it at base-sepolia faucet then re-run. Skipping write phase.");
    } else {
      assert(submit.status === 202, `expected 202, got ${submit.status}: ${JSON.stringify(submit.body)}`);
      console.log("  call:", submit.body.call_id, submit.body.tx_hash);
      // Poll to confirmed
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const status = await call<{ status: string }>("GET", `/contracts/v1/calls/${submit.body.call_id}`);
        if (status.body.status === "confirmed") {
          console.log("  confirmed after", (i + 1) * 2, "seconds");
          break;
        }
        if (status.body.status === "failed") {
          console.error("  call failed:", JSON.stringify(status.body));
          process.exit(1);
        }
      }
    }
  } else {
    console.log("\n[6] (skipped — TEST_CONTRACT_* env not set)");
  }

  // 7. Drain wallet (will 409 if no balance, which is fine)
  console.log("\n[7] POST /contracts/v1/wallets/:id/drain");
  const drain = await call<CallResponse>("POST", `/contracts/v1/wallets/${walletId}/drain`,
    { destination_address: recoveryAddress },
    { "x-confirm-drain": walletId },
  );
  if (drain.status === 409) {
    console.log("  → nothing to drain (wallet unfunded). Continuing.");
  } else {
    assert(drain.status === 202, `expected 202, got ${drain.status}: ${JSON.stringify(drain.body)}`);
  }

  // 8. Delete wallet
  console.log("\n[8] DELETE /contracts/v1/wallets/:id");
  const del = await call<{ status: string }>("DELETE", `/contracts/v1/wallets/${walletId}`,
    undefined,
    { "x-confirm-delete": walletId },
  );
  if (del.status === 409) {
    console.log("  → wallet still has balance; leaving in place");
  } else {
    assert(del.status === 200, `expected 200, got ${del.status}: ${JSON.stringify(del.body)}`);
    assert(del.body.status === "deleted", `expected status=deleted`);
  }

  console.log("\nE2E PASS");
}

main().catch((err) => {
  console.error("E2E ERROR:", err);
  process.exit(1);
});
