import { readAllowance, saveAllowance, loadKeyStore, configDir } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { fail } from "./sdk-errors.mjs";
import { setTierAction, deployAction } from "./next-actions.mjs";
import { getActiveProfile } from "../core-dist/config.js";
import { readMeta } from "../core-dist/profiles.js";
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

Options:
  --switch-rail   Confirm switching the persisted payment rail. Re-running
                  init with the SAME rail as the existing allowance is always
                  idempotent and does not need this flag.

Output:
  Stdout is a JSON summary { config_dir, wallet, rail, network, balances,
  tier, projects_saved, next_step }. Progress lines (Config / Allowance /
  Balance / Tier / Next) go to stderr so a human re-running interactively
  sees what's happening while a script piping stdout to jq stays clean.

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
  // Capability `astro-ssr-runtime` (v1.52): scaffold an Astro project.
  // Sub-routes when first positional is 'astro'. Handle BEFORE the
  // outer --help check so `run402 init astro --help` shows the astro
  // scaffolder's help, not the rail-setup help. The rest of init's
  // payment-rail setup is intentionally orthogonal — agents typically
  // run `run402 init astro <dir>` to scaffold AND `run402 init` once
  // to set up allowance / tier.
  if (args[0] === "astro") {
    const { runInitAstro } = await import("./init-astro.mjs");
    await runInitAstro(args.slice(1));
    return;
  }

  if (args.includes("--help") || args.includes("-h")) { console.log(HELP); process.exit(0); }

  // Resolve once for this invocation — reflects the active wallet/profile that
  // cli.mjs published to RUN402_WALLET before this module loaded.
  const CONFIG_DIR = configDir();

  const isMpp = args[0] === "mpp";
  const requestedRail = isMpp ? "mpp" : "x402";
  const switchRailConfirmed = args.includes("--switch-rail");

  const existingAllowance = readAllowance();
  if (existingAllowance?.rail && existingAllowance.rail !== requestedRail && !switchRailConfirmed) {
    fail({
      code: "RAIL_SWITCH_REQUIRES_CONFIRM",
      message: `Already on rail '${existingAllowance.rail}'. Pass --switch-rail to switch to '${requestedRail}'.`,
      details: { current_rail: existingAllowance.rail, requested_rail: requestedRail },
    });
  }

  // Human-readable progress lines go to stderr so stdout stays JSON-clean for
  // agents. Final structured summary emits to stdout at the end.
  const write = (s) => console.error(s);
  const line = (label, value) => write(`  ${label.padEnd(10)} ${value}`);
  const summary = {
    config_dir: CONFIG_DIR,
    wallet: null,
    rail: null,
    network: null,
    balances: null,
    tier: null,
    projects_saved: 0,
    next_actions: [],
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

  const walletName = getActiveProfile();
  const walletMeta = readMeta(walletName);
  summary.wallet = { local_label: walletName, server_label: walletMeta?.label ?? null, address: allowance.address };
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
    }
  }

  // Balances mirror `run402 status`: the on-chain figure above plus the
  // Run402-held prepaid credit (rail-independent). Prepaid credit is fetched
  // best-effort so a billing read failure never blocks setup.
  const billing = await getSdk().billing.checkBalance(allowance.address).catch(() => null);
  const hasBilling = billing && billing.exists !== false;
  summary.balances = {
    on_chain_usd_micros: balance,
    on_chain_token: isMpp ? "pathUSD" : "USDC",
    prepaid_credit_usd_micros: hasBilling ? billing.available_usd_micros : null,
    held_usd_micros: hasBilling ? (billing.held_usd_micros ?? 0) : null,
  };

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

  // 6. Next step — canonical typed action(s); `next_step` is the back-compat
  // string mirror of the first action's command (one spelling, surface-wide).
  write("");
  const tierMissing = !tierInfo || !tierInfo.tier || !tierInfo.active;
  summary.next_actions = [tierMissing ? setTierAction("prototype") : deployAction()];
  summary.next_step = summary.next_actions[0].command;
  if (tierMissing) {
    write("  Next: run402 tier set prototype");
  } else {
    write("  Ready to deploy. Run: run402 deploy apply --manifest app.json");
  }
  write("");

  console.log(JSON.stringify(summary, null, 2));
}
