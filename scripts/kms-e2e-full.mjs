// Full-lifecycle E2E proof for kms-wallet-contracts against api.run402.com.
// Uses the project service_key created earlier + funds the KMS wallet from
// agentdb/faucet-treasury-key so the on-chain call stage actually runs.
import { execSync } from "node:child_process";
import { createWalletClient, createPublicClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const API = "https://api.run402.com";
const API_KEY = process.env.E2E_PROJECT_API_KEY;
const TEST_CONTRACT = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // USDC on base-sepolia
if (!API_KEY) { console.error("need E2E_PROJECT_API_KEY"); process.exit(1); }

const funderPk = execSync('aws secretsmanager get-secret-value --secret-id agentdb/faucet-treasury-key --query SecretString --output text --region us-east-1 --profile kychee', { encoding: "utf-8" }).trim();
const funder = privateKeyToAccount(funderPk);
const wallet = createWalletClient({ account: funder, chain: baseSepolia, transport: http() });
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });

async function call(method, path, body, extra={}) {
  const r = await fetch(`${API}${path}`, {
    method, headers: { "content-type":"application/json", authorization:`Bearer ${API_KEY}`, ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let parsed; try { parsed = JSON.parse(t); } catch { parsed = t; }
  return { status: r.status, body: parsed };
}

function log(label, res) {
  const summary = typeof res.body === "string" ? res.body.slice(0,200) : JSON.stringify(res.body).slice(0,200);
  console.log(`[${label}] ${res.status} — ${summary}`);
  if (res.status >= 400 && res.status !== 409) { console.error("FAIL"); process.exit(1); }
}

console.log("Funder:", funder.address);

// 1) Provision
const prov = await call("POST", "/contracts/v1/wallets", { chain:"base-sepolia" });
log("1 provision", prov);
const walletId = prov.body.id;
const kmsAddr = prov.body.address;
console.log(`  walletId=${walletId} addr=${kmsAddr}`);

// 2) GET
log("2 get", await call("GET", `/contracts/v1/wallets/${walletId}`));

// 3) LIST
log("3 list", await call("GET", "/contracts/v1/wallets"));

// 4) Set recovery
log("4 recovery", await call("POST", `/contracts/v1/wallets/${walletId}/recovery-address`, { recovery_address: funder.address }));

// 5) Set alert threshold
log("5 alert", await call("POST", `/contracts/v1/wallets/${walletId}/alert`, { threshold_wei: "100000000000000" }));

// 6) Fund KMS wallet with 0.0005 ETH for gas
console.log("[6a] funding KMS wallet with 0.0005 ETH...");
const txHash = await wallet.sendTransaction({ to: kmsAddr, value: parseEther("0.0005") });
console.log("  fund tx:", txHash);
await publicClient.waitForTransactionReceipt({ hash: txHash });
console.log("  confirmed");

// 7) Contract call ping(42)
const abi = [{ type:"function", name:"approve", inputs:[{name:"spender",type:"address"},{name:"amount",type:"uint256"}], outputs:[{type:"bool"}] }];
const submit = await call("POST", "/contracts/v1/call", {
  wallet_id: walletId, chain: "base-sepolia",
  contract_address: TEST_CONTRACT, abi_fragment: abi,
  function_name: "approve", args: ["0x0000000000000000000000000000000000000001", "1000000"],
});
log("7 call submit", submit);
const callId = submit.body.call_id;

// 8) Poll to confirmed
let confirmed = false;
for (let i=0; i<90; i++) {
  await new Promise(r=>setTimeout(r, 2000));
  const s = await call("GET", `/contracts/v1/calls/${callId}`);
  if (s.body.status === "confirmed") { confirmed = true; console.log(`[8] confirmed after ${(i+1)*2}s tx=${s.body.tx_hash}`); break; }
  if (s.body.status === "failed") { console.error("[8] failed", s.body); process.exit(1); }
  if (i % 5 === 0) console.log(`  [${(i+1)*2}s] status=${s.body.status}`);
}
if (!confirmed) { console.error("[8] timeout"); process.exit(1); }

// 9) Drain to funder address
const drain = await call("POST", `/contracts/v1/wallets/${walletId}/drain`, { destination_address: funder.address }, { "x-confirm-drain": walletId });
log("9 drain", drain);

// 10) Wait for drain to clear then delete
if (drain.body.call_id) {
  for (let i=0; i<45; i++) {
    await new Promise(r=>setTimeout(r, 2000));
    const s = await call("GET", `/contracts/v1/calls/${drain.body.call_id}`);
    if (s.body.status === "confirmed") { console.log(`[10a] drain confirmed after ${(i+1)*2}s`); break; }
    if (s.body.status === "failed") { console.error("[10a] drain failed"); process.exit(1); }
  }
}

const del = await call("DELETE", `/contracts/v1/wallets/${walletId}`, undefined, { "x-confirm-delete": walletId });
log("10 delete", del);

console.log("\n✅ KMS wallet contracts E2E PASS");
console.log(`   provisioned → funded → on-chain call confirmed → drained → deleted`);
console.log(`   kms wallet: ${kmsAddr}`);
console.log(`   contract:   ${TEST_CONTRACT}`);
console.log(`   call id:    ${callId}`);
