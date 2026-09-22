import { z } from "zod";
import { mkdirSync } from "node:fs";
import { getConfigDir } from "../config.js";
import { readWallet, saveWallet } from "../wallet.js";
import { loadKeyStore } from "../keystore.js";
import { getSdk } from "../sdk.js";
import { isToolAvailable } from "../tool-profiles.js";
import { fundingRecovery, fundingBlocksBootstrap } from "../../sdk/dist/node/index.js";

const TEMPO_RPC = "https://rpc.moderato.tempo.xyz/";

export const initSchema = {
  rail: z
    .enum(["x402", "mpp", "lightning"])
    .optional()
    .describe("Payment rail: x402 (Base Sepolia, default), mpp (Tempo Moderato), or lightning (a budgeted wallet minted on Run402's Hub, with the Base wallet as the x402 fallback)"),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function short(addr: string) {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

export async function handleInit(args: { rail?: "x402" | "mpp" | "lightning" }): Promise<McpResult> {
  const rail = args.rail ?? "x402";
  const lines: string[] = [];

  // 1. Config directory
  const configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });

  // 2. Wallet — create or reuse (via SDK when possible)
  // readWallet throws on a malformed-shape file; surface a friendly
  // error rather than crashing the tool.
  let localWallet;
  try {
    localWallet = readWallet();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Wallet file is malformed: ${msg}` }],
      isError: true,
    };
  }
  let walletCreated = false;

  if (!localWallet) {
    try {
      await getSdk().wallets.create();
    } catch {
      // `wallet already exists` would only fire if another process created one between the check and the call — ignore
    }
    try {
      localWallet = readWallet();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Wallet file is malformed: ${msg}` }],
        isError: true,
      };
    }
    // Stamp the rail on the newly-created wallet.
    if (localWallet) {
      localWallet = { ...localWallet, rail };
      saveWallet(localWallet);
    }
    walletCreated = true;
  } else if (localWallet.rail !== rail) {
    localWallet = { ...localWallet, rail };
    saveWallet(localWallet);
  }

  if (!localWallet) {
    return {
      content: [{ type: "text", text: "Error: Failed to create or read the agent wallet." }],
      isError: true,
    };
  }

  // 3. Faucet — request if not yet funded
  let faucetStatus = "skipped (already funded)";
  let fundingError: unknown;

  if (!localWallet.funded) {
    if (rail === "mpp") {
      // Tempo Moderato faucet via JSON-RPC — not in the SDK surface (x402-only).
      try {
        const res = await fetch(TEMPO_RPC, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "tempo_fundAddress",
            params: [localWallet.address],
            id: 1,
          }),
        });
        const data = (await res.json()) as { result?: unknown; error?: { message?: string } };
        if (data.result) {
          localWallet = { ...localWallet, funded: true, lastFaucet: new Date().toISOString() };
          saveWallet(localWallet);
          faucetStatus = "funded (Tempo pathUSD)";
        } else {
          fundingError = data.error ?? new Error("Faucet failed");
          faucetStatus = `failed: ${data.error?.message || "unknown error"}`;
        }
      } catch (err) {
        fundingError = err;
        faucetStatus = `error: ${(err as Error).message}`;
      }
    } else {
      // x402 faucet via SDK (updates `funded` / `lastFaucet` via the provider).
      try {
        const body = await getSdk().wallets.faucet(localWallet.address);
        faucetStatus = body.amount ? `funded (${body.amount} ${body.token || "USDC"})` : "funded";
        // Re-read wallet to pick up the funded/lastFaucet fields the SDK wrote.
        localWallet = readWallet() ?? localWallet;
      } catch (err) {
        fundingError = err;
        const msg = (err as Error)?.message ?? String(err);
        faucetStatus = `failed: ${msg}`;
      }
    }
  }

  // 3b. The Lightning wallet: a budgeted wallet minted on Run402's Hub;
  // the pairing is stored locally by the wallet tool and never rendered here.
  let lightningStatus: string | null = null;
  if (rail === "lightning") {
    const { handleLightningWallet } = await import("./lightning-wallet.js");
    const minted = await handleLightningWallet({ action: "mint" });
    const text = minted.content[0]?.text ?? "";
    const status = /\| status \| ([a-z_]+) \|/.exec(text)?.[1] ?? (minted.isError ? "failed" : "unknown");
    const walletId = /\| wallet_id \| `([^`]+)` \|/.exec(text)?.[1];
    lightningStatus = minted.isError
      ? `not available (${text.split("\n").find((line) => line.trim().length > 0) ?? "error"}) — paying over x402 until it is`
      : `${status}${walletId ? ` (${walletId})` : ""}`;
  }

  // 4. Tier status
  let tierDisplay = "(none)";
  try {
    const body = await getSdk().tier.status();
    if (body.tier && body.active) {
      const expiry = body.lease_expires_at ? body.lease_expires_at.split("T")[0] : "unknown";
      tierDisplay = `${body.tier} (expires ${expiry})`;
    }
  } catch {
    // tier status is best-effort — leave at (none)
  }

  // 5. Project count
  const store = loadKeyStore();
  const projectCount = Object.keys(store.projects).length;

  // 6. Build summary
  lines.push(
    `## Run402 Init`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| config | \`${configDir}\` |`,
    `| address | \`${short(localWallet.address)}\`${walletCreated ? " (created)" : ""} |`,
    `| network | ${rail === "mpp" ? "Tempo Moderato (testnet)" : rail === "lightning" ? "Bitcoin mainnet (Lightning) + Base Sepolia fallback" : "Base Sepolia (testnet)"} |`,
    `| rail | ${rail} |`,
    `| faucet | ${faucetStatus} |`,
    ...(lightningStatus ? [`| lightning | ${lightningStatus} |`] : []),
    `| tier | ${tierDisplay} |`,
    `| projects | ${projectCount} active |`,
  );

  // Next step.
  //
  // Under a buy-only profile BOTH branches were wrong, not just the no-tier one.
  // A tier buys PROJECT HOSTING; `tier_set`, `provision_postgres_project` and
  // `deploy` are none of them registered for a buyer, so whichever branch fired
  // sent them to tools they do not have — and told them to do something they did
  // not come to do. A buyer's next step is the purchase, tier or no tier.
  lines.push(``);
  const recovery = fundingRecovery(fundingError);
  if (fundingBlocksBootstrap(recovery, { activeTier: tierDisplay !== "(none)" })) {
    lines.push(`**Funding ${recovery!.status}.** ${recovery!.next_actions[0]!.why}`);
    if (recovery!.transaction_hash) lines.push(`Transaction: \`${recovery!.transaction_hash}\`.`);
    lines.push(`\nFunding recovery: \`${JSON.stringify(recovery)}\``);
  } else if (tierDisplay === "(none)") {
    lines.push(
      isToolAvailable("tier_set")
        ? `**Next:** Use \`tier_set\` to set a tier (prototype is free).`
        // The faucet funds Base Sepolia ONLY, so following this path settles on
        // testnet and never produces a real payment. The mainnet on-ramp exists
        // (send USDC to the exported address) but was documented ONLY in
        // llms-mcp.txt — invisible to an agent that reads the tool surface and
        // nothing else, which is exactly what the buyer profile is for.
        : `**Ready to buy.** Use \`generate_image\` ($0.03 per image) — no tier needed.\n` +
          `Note: the faucet funds Base Sepolia (testnet). To pay on Base MAINNET with real USDC, ` +
          `send USDC to your address from \`wallet_export\` first.`,
    );
  } else {
    lines.push(
      isToolAvailable("provision_postgres_project")
        ? `**Ready to deploy.** Use \`provision_postgres_project\` to create a project, then \`deploy\` to ship a release.`
        : `**Ready to buy.** Use \`generate_image\` ($0.03 per image).`,
    );
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
