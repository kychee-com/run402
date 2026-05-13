import { z } from "zod";
import { mkdirSync } from "node:fs";
import { getConfigDir } from "../config.js";
import { readAllowance, saveAllowance } from "../allowance.js";
import { loadKeyStore } from "../keystore.js";
import { getSdk } from "../sdk.js";

const TEMPO_RPC = "https://rpc.moderato.tempo.xyz/";

export const initSchema = {
  rail: z
    .enum(["x402", "mpp"])
    .optional()
    .describe("Payment rail: x402 (Base Sepolia, default) or mpp (Tempo Moderato)"),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function short(addr: string) {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

export async function handleInit(args: { rail?: "x402" | "mpp" }): Promise<McpResult> {
  const rail = args.rail ?? "x402";
  const lines: string[] = [];

  // 1. Config directory
  const configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });

  // 2. Allowance — create or reuse (via SDK when possible)
  // GH-194: readAllowance throws on a malformed-shape file; surface a friendly
  // error rather than crashing the tool.
  let allowance;
  try {
    allowance = readAllowance();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Allowance file is malformed: ${msg}` }],
      isError: true,
    };
  }
  let allowanceCreated = false;

  if (!allowance) {
    try {
      await getSdk().allowance.create();
    } catch {
      // `allowance already exists` would only fire if another process created one between the check and the call — ignore
    }
    try {
      allowance = readAllowance();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Allowance file is malformed: ${msg}` }],
        isError: true,
      };
    }
    // Stamp the rail on the newly-created allowance.
    if (allowance) {
      allowance = { ...allowance, rail };
      saveAllowance(allowance);
    }
    allowanceCreated = true;
  } else if (allowance.rail !== rail) {
    allowance = { ...allowance, rail };
    saveAllowance(allowance);
  }

  if (!allowance) {
    return {
      content: [{ type: "text", text: "Error: Failed to create or read the agent allowance." }],
      isError: true,
    };
  }

  // 3. Faucet — request if not yet funded
  let faucetStatus = "skipped (already funded)";

  if (!allowance.funded) {
    if (rail === "mpp") {
      // Tempo Moderato faucet via JSON-RPC — not in the SDK surface (x402-only).
      try {
        const res = await fetch(TEMPO_RPC, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "tempo_fundAddress",
            params: [allowance.address],
            id: 1,
          }),
        });
        const data = (await res.json()) as { result?: unknown; error?: { message?: string } };
        if (data.result) {
          allowance = { ...allowance, funded: true, lastFaucet: new Date().toISOString() };
          saveAllowance(allowance);
          faucetStatus = "funded (Tempo pathUSD)";
        } else {
          faucetStatus = `failed: ${data.error?.message || "unknown error"}`;
        }
      } catch (err) {
        faucetStatus = `error: ${(err as Error).message}`;
      }
    } else {
      // x402 faucet via SDK (updates `funded` / `lastFaucet` via the provider).
      try {
        const body = await getSdk().allowance.faucet(allowance.address);
        faucetStatus = body.amount ? `funded (${body.amount} ${body.token || "USDC"})` : "funded";
        // Re-read allowance to pick up the funded/lastFaucet fields the SDK wrote.
        allowance = readAllowance() ?? allowance;
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        faucetStatus = `failed: ${msg}`;
      }
    }
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
    `| allowance | \`${short(allowance.address)}\`${allowanceCreated ? " (created)" : ""} |`,
    `| network | ${rail === "mpp" ? "Tempo Moderato (testnet)" : "Base Sepolia (testnet)"} |`,
    `| rail | ${rail} |`,
    `| faucet | ${faucetStatus} |`,
    `| tier | ${tierDisplay} |`,
    `| projects | ${projectCount} active |`,
  );

  // Next step
  lines.push(``);
  if (tierDisplay === "(none)") {
    lines.push(`**Next:** Use \`set_tier\` to subscribe to a tier (e.g. prototype).`);
  } else {
    lines.push(`**Ready to deploy.** Use \`provision_postgres_project\` to create a project, then \`deploy\` to ship a release.`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
