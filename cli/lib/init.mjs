import { readWallet, saveWallet, loadKeyStore, CONFIG_DIR, WALLET_FILE, API } from "./config.mjs";
import { mkdirSync } from "fs";

const USDC_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }];
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function short(addr) { return addr.slice(0, 6) + "..." + addr.slice(-4); }
function line(label, value) { console.log(`  ${label.padEnd(10)} ${value}`); }

export async function run() {
  console.log();

  // 1. Config directory
  mkdirSync(CONFIG_DIR, { recursive: true });
  line("Config", CONFIG_DIR);

  // 2. Wallet
  let wallet = readWallet();
  if (!wallet) {
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    wallet = { address: account.address, privateKey, created: new Date().toISOString(), funded: false };
    saveWallet(wallet);
    line("Wallet", `${short(wallet.address)} (created)`);
  } else {
    line("Wallet", short(wallet.address));
  }

  // 3. Balance — check on-chain, faucet if zero
  const { createPublicClient, http } = await import("viem");
  const { baseSepolia } = await import("viem/chains");
  const client = createPublicClient({ chain: baseSepolia, transport: http() });

  let balance = 0;
  try {
    const raw = await client.readContract({ address: USDC_SEPOLIA, abi: USDC_ABI, functionName: "balanceOf", args: [wallet.address] });
    balance = Number(raw);
  } catch {}

  if (balance === 0) {
    line("Balance", "0 USDC — requesting faucet...");
    const res = await fetch(`${API}/faucet/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: wallet.address }),
    });
    if (res.ok) {
      // Poll for up to 30s
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const raw = await client.readContract({ address: USDC_SEPOLIA, abi: USDC_ABI, functionName: "balanceOf", args: [wallet.address] });
          balance = Number(raw);
          if (balance > 0) break;
        } catch {}
      }
      saveWallet({ ...wallet, funded: true, lastFaucet: new Date().toISOString() });
      if (balance > 0) {
        line("Balance", `${(balance / 1e6).toFixed(2)} USDC (funded)`);
      } else {
        line("Balance", "faucet sent — not yet confirmed on-chain");
      }
    } else {
      const data = await res.json().catch(() => ({}));
      const msg = data.error || data.message || `HTTP ${res.status}`;
      line("Balance", `faucet failed: ${msg}`);
    }
  } else {
    line("Balance", `${(balance / 1e6).toFixed(2)} USDC`);
  }

  // 4. Tier status
  let tierInfo = null;
  try {
    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(wallet.privateKey);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await account.signMessage({ message: `run402:${timestamp}` });
    const res = await fetch(`${API}/tiers/v1/status`, {
      headers: { "X-Run402-Wallet": account.address, "X-Run402-Signature": signature, "X-Run402-Timestamp": timestamp },
    });
    if (res.ok) tierInfo = await res.json();
  } catch {}

  if (tierInfo && tierInfo.tier && tierInfo.status === "active") {
    const expiry = tierInfo.lease_expires_at ? tierInfo.lease_expires_at.split("T")[0] : "unknown";
    line("Tier", `${tierInfo.tier} (expires ${expiry})`);
  } else {
    line("Tier", "(none)");
  }

  // 5. Projects
  const store = loadKeyStore();
  line("Projects", `${Object.keys(store.projects).length} active`);

  // 6. Next step
  console.log();
  if (!tierInfo || !tierInfo.tier || tierInfo.status !== "active") {
    console.log("  Next: run402 tier set prototype");
  } else {
    console.log("  Ready to deploy. Run: run402 deploy --manifest app.json");
  }
  console.log();
}
