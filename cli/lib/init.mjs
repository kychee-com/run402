import { readAllowance, saveAllowance, loadKeyStore, CONFIG_DIR } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { mkdirSync } from "fs";

const USDC_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }];
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const TEMPO_RPC = "https://rpc.moderato.tempo.xyz/";

const HELP = `run402 init — Set up allowance, funding, and check tier status

Usage:
  run402 init                Set up with x402 (Base Sepolia) — default
  run402 init mpp            Set up with MPP (Tempo Moderato)
  run402 init <rail> --switch-rail
                             Switch the persisted payment rail to <rail>.
                             Required when an allowance already exists on
                             the other rail; protects scripted re-runs from
                             silently flipping billing networks.
  run402 init --json         Same as init, but emit a JSON summary on stdout
                             (human lines go to stderr — for agent automation)

Options:
  --switch-rail   Confirm switching the persisted payment rail. Re-running
                  init with the SAME rail as the existing allowance is always
                  idempotent and does not need this flag.
  --json          Emit a structured JSON summary on stdout.

Steps (idempotent when re-run with the same rail; pass --switch-rail to change rails):
  1. Creates config directory (~/.config/run402)
  2. Creates agent allowance if none exists
  3. Checks on-chain balance; requests faucet if zero
  4. Shows current tier subscription status
  5. Lists local project count
  6. Suggests next step (tier set or deploy)

Run this once to get started, or again to check your setup.
`;

function short(addr) { return addr.slice(0, 6) + "..." + addr.slice(-4); }

function errorMessage(err) {
  if (err?.body && typeof err.body === "object") return err.body.message || err.body.error || err.message;
  return err?.message || String(err);
}

export async function run(args = []) {
  if (args.includes("--help") || args.includes("-h")) { console.log(HELP); process.exit(0); }
  const jsonMode = args.includes("--json");
  const isMpp = args[0] === "mpp";
  const requestedRail = isMpp ? "mpp" : "x402";
  const switchRailConfirmed = args.includes("--switch-rail");

  const existingAllowance = readAllowance();
  if (existingAllowance?.rail && existingAllowance.rail !== requestedRail && !switchRailConfirmed) {
    console.error(JSON.stringify({
      status: "error",
      code: "RAIL_SWITCH_REQUIRES_CONFIRM",
      message: `Already on rail '${existingAllowance.rail}'. Pass --switch-rail to switch to '${requestedRail}'.`,
      details: { current_rail: existingAllowance.rail, requested_rail: requestedRail },
    }));
    process.exit(1);
  }

  // In --json mode, human-readable lines go to stderr so stdout stays clean for
  // agents. We also collect structured data for the final JSON emit.
  const write = jsonMode ? (s) => console.error(s) : (s) => console.log(s);
  const line = (label, value) => write(`  ${label.padEnd(10)} ${value}`);
  const summary = {
    config_dir: CONFIG_DIR,
    allowance: null,
    rail: null,
    network: null,
    balance: null,
    tier: null,
    projects_saved: 0,
    next_step: null,
  };

  write("");

  // 1. Config directory
  mkdirSync(CONFIG_DIR, { recursive: true });
  line("Config", CONFIG_DIR);

  // 2. Allowance
  let allowance = existingAllowance;
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

  summary.allowance = { address: allowance.address, funded: allowance.funded || false };
  summary.network = isMpp ? "tempo-moderato" : "base-sepolia";
  summary.rail = isMpp ? "mpp" : "x402";

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
          // Tempo faucet is "instant" on-chain, but the client RPC read can be
          // racy relative to faucet settlement — poll up to 30s (GH-81), mirroring
          // the x402 path below.
          for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
              const raw = await client.readContract({ address: PATH_USD, abi: USDC_ABI, functionName: "balanceOf", args: [allowance.address] });
              balance = Number(raw);
              if (balance > 0) break;
            } catch {}
          }
          saveAllowance({ ...allowance, funded: true, lastFaucet: new Date().toISOString() });
          summary.allowance.funded = true;
          if (balance > 0) {
            line("Balance", `${(balance / 1e6).toFixed(2)} pathUSD (funded)`);
          } else {
            line("Balance", "faucet sent — not yet confirmed on-chain");
          }
        } else {
          line("Balance", `faucet failed: ${data.error?.message || "unknown error"}`);
        }
      } catch (err) {
        line("Balance", `faucet error: ${err.message}`);
      }
    } else {
      line("Balance", `${(balance / 1e6).toFixed(2)} pathUSD`);
      summary.allowance.funded = balance > 0;
    }
    summary.balance = { symbol: "pathUSD", usd_micros: balance };
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
      try {
        await getSdk().allowance.faucet(allowance.address);
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
        summary.allowance.funded = true;
        if (balance > 0) {
          line("Balance", `${(balance / 1e6).toFixed(2)} USDC (funded)`);
        } else {
          line("Balance", "faucet sent — not yet confirmed on-chain");
        }
      } catch (err) {
        line("Balance", `faucet failed: ${errorMessage(err)}`);
      }
    } else {
      line("Balance", `${(balance / 1e6).toFixed(2)} USDC`);
      summary.allowance.funded = balance > 0;
    }
    summary.balance = { symbol: "USDC", usd_micros: balance };
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
    tierInfo = await getSdk().tier.status();
  } catch {}

  if (tierInfo && tierInfo.tier && tierInfo.active) {
    const expiry = tierInfo.lease_expires_at ? tierInfo.lease_expires_at.split("T")[0] : "unknown";
    line("Tier", `${tierInfo.tier} (expires ${expiry})`);
    summary.tier = { name: tierInfo.tier, expires: tierInfo.lease_expires_at || null };
  } else {
    line("Tier", "(none)");
    summary.tier = null;
  }

  // 5. Projects — count locally saved project entries. Note: "saved" (not
  // "active") — these are all projects in the keystore, regardless of whether
  // the server considers them active.
  summary.projects_saved = Object.keys(store.projects).length;
  line("Projects", `${summary.projects_saved} saved`);

  // 6. Next step
  write("");
  const nextStep = (!tierInfo || !tierInfo.tier || !tierInfo.active)
    ? "run402 tier set prototype"
    : "run402 deploy apply --manifest app.json";
  if (!tierInfo || !tierInfo.tier || !tierInfo.active) {
    write("  Next: run402 tier set prototype");
  } else {
    write("  Ready to deploy. Run: run402 deploy apply --manifest app.json");
  }
  write("");
  summary.next_step = nextStep;

  if (jsonMode) {
    console.log(JSON.stringify(summary, null, 2));
  }
}
