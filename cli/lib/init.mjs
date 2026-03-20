import { readAllowance, saveAllowance, loadKeyStore, CONFIG_DIR, ALLOWANCE_FILE, API } from "./config.mjs";
import { getAllowanceAuthHeaders } from "../core-dist/allowance-auth.js";
import { mkdirSync } from "fs";

const USDC_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }];
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const TEMPO_RPC = "https://rpc.moderato.tempo.xyz/";

const HELP = `run402 init — Set up allowance, funding, and check tier status

Usage:
  run402 init          Set up with x402 (Base Sepolia) — default
  run402 init mpp      Set up with MPP (Tempo Moderato)

Steps (idempotent — safe to re-run):
  1. Creates config directory (~/.config/run402)
  2. Creates agent allowance if none exists
  3. Checks on-chain balance; requests faucet if zero
  4. Shows current tier subscription status
  5. Lists local project count
  6. Suggests next step (tier set or deploy)

Run this once to get started, or again to check your setup.
`;

function short(addr) { return addr.slice(0, 6) + "..." + addr.slice(-4); }
function line(label, value) { console.log(`  ${label.padEnd(10)} ${value}`); }

export async function run(args = []) {
  if (args.includes("--help") || args.includes("-h")) { console.log(HELP); process.exit(0); }
  const isMpp = args[0] === "mpp";
  console.log();

  // 1. Config directory
  mkdirSync(CONFIG_DIR, { recursive: true });
  line("Config", CONFIG_DIR);

  // 2. Allowance
  let allowance = readAllowance();
  const previousRail = allowance?.rail;
  if (!allowance) {
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    allowance = { address: account.address, privateKey, created: new Date().toISOString(), funded: false, rail: isMpp ? "mpp" : "x402" };
    saveAllowance(allowance);
    line("Allowance", `${short(allowance.address)} (created)`);
  } else {
    // Update rail if switching
    if ((isMpp && allowance.rail !== "mpp") || (!isMpp && allowance.rail === "mpp")) {
      allowance = { ...allowance, rail: isMpp ? "mpp" : "x402" };
      saveAllowance(allowance);
    } else if (!allowance.rail) {
      allowance = { ...allowance, rail: isMpp ? "mpp" : "x402" };
      saveAllowance(allowance);
    }
    line("Allowance", short(allowance.address));
  }

  line("Network", isMpp ? "Tempo Moderato (testnet)" : "Base Sepolia (testnet)");
  line("Rail", isMpp ? "mpp" : "x402");

  // 3. Balance — check on-chain, faucet if zero
  let balance = 0;

  if (isMpp) {
    // Tempo Moderato: read pathUSD balance
    const { createPublicClient, http, defineChain } = await import("viem");
    const tempoModerato = defineChain({
      id: 42431,
      name: "Tempo Moderato",
      nativeCurrency: { name: "pathUSD", symbol: "pathUSD", decimals: 6 },
      rpcUrls: { default: { http: [TEMPO_RPC] } },
    });
    const client = createPublicClient({ chain: tempoModerato, transport: http() });

    try {
      const raw = await client.readContract({ address: PATH_USD, abi: USDC_ABI, functionName: "balanceOf", args: [allowance.address] });
      balance = Number(raw);
    } catch {}

    if (balance === 0) {
      line("Balance", "0 pathUSD — requesting Tempo faucet...");
      try {
        const res = await fetch(TEMPO_RPC, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "tempo_fundAddress", params: [allowance.address], id: 1 }),
        });
        const data = await res.json();
        if (data.result) {
          // Tempo faucet is instant — re-read balance once
          try {
            const raw = await client.readContract({ address: PATH_USD, abi: USDC_ABI, functionName: "balanceOf", args: [allowance.address] });
            balance = Number(raw);
          } catch {}
          saveAllowance({ ...allowance, funded: true, lastFaucet: new Date().toISOString() });
          if (balance > 0) {
            line("Balance", `${(balance / 1e6).toFixed(2)} pathUSD (funded)`);
          } else {
            line("Balance", "faucet sent — checking balance...");
          }
        } else {
          line("Balance", `faucet failed: ${data.error?.message || "unknown error"}`);
        }
      } catch (err) {
        line("Balance", `faucet error: ${err.message}`);
      }
    } else {
      line("Balance", `${(balance / 1e6).toFixed(2)} pathUSD`);
    }
  } else {
    // Base Sepolia: read USDC balance (existing behavior)
    const { createPublicClient, http } = await import("viem");
    const { baseSepolia } = await import("viem/chains");
    const client = createPublicClient({ chain: baseSepolia, transport: http() });

    try {
      const raw = await client.readContract({ address: USDC_SEPOLIA, abi: USDC_ABI, functionName: "balanceOf", args: [allowance.address] });
      balance = Number(raw);
    } catch {}

    if (balance === 0) {
      line("Balance", "0 USDC — requesting faucet...");
      const res = await fetch(`${API}/faucet/v1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: allowance.address }),
      });
      if (res.ok) {
        // Poll for up to 30s
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            const raw = await client.readContract({ address: USDC_SEPOLIA, abi: USDC_ABI, functionName: "balanceOf", args: [allowance.address] });
            balance = Number(raw);
            if (balance > 0) break;
          } catch {}
        }
        saveAllowance({ ...allowance, funded: true, lastFaucet: new Date().toISOString() });
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
  }

  // Show note if switching rails
  if (previousRail && previousRail !== (isMpp ? "mpp" : "x402")) {
    const prev = previousRail === "mpp" ? "Tempo pathUSD" : "Base Sepolia USDC";
    line("Note", `Switched from ${previousRail} — ${prev} balance still available if you switch back`);
  }

  // 4. Tier status
  const store = loadKeyStore();
  let tierInfo = null;
  try {
    const authHeaders = getAllowanceAuthHeaders("/tiers/v1/status");
    if (authHeaders) {
      const res = await fetch(`${API}/tiers/v1/status`, {
        headers: { ...authHeaders },
      });
      if (res.ok) tierInfo = await res.json();
    }
  } catch {}

  if (tierInfo && tierInfo.tier && tierInfo.active) {
    const expiry = tierInfo.lease_expires_at ? tierInfo.lease_expires_at.split("T")[0] : "unknown";
    line("Tier", `${tierInfo.tier} (expires ${expiry})`);
  } else {
    line("Tier", "(none)");
  }

  // 5. Projects
  line("Projects", `${Object.keys(store.projects).length} active`);

  // 6. Next step
  console.log();
  if (!tierInfo || !tierInfo.tier || !tierInfo.active) {
    console.log("  Next: run402 tier set prototype");
  } else {
    console.log("  Ready to deploy. Run: run402 deploy --manifest app.json");
  }
  console.log();
}
