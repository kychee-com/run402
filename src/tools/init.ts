import { z } from "zod";
import { mkdirSync } from "node:fs";
import { randomBytes, createECDH } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { getConfigDir } from "../config.js";
import { readAllowance, saveAllowance } from "../allowance.js";
import { loadKeyStore } from "../keystore.js";
import { getAllowanceAuthHeaders } from "../allowance-auth.js";
import { apiRequest } from "../client.js";

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

  // 2. Allowance — create or reuse
  let allowance = readAllowance();
  let allowanceCreated = false;

  if (!allowance) {
    const privateKeyBytes = randomBytes(32);
    const privateKey = `0x${privateKeyBytes.toString("hex")}`;

    const ecdh = createECDH("secp256k1");
    ecdh.setPrivateKey(privateKeyBytes);
    const uncompressedPubKey = ecdh.getPublicKey();
    const pubKeyBody = uncompressedPubKey.subarray(1);

    const hash = keccak_256(pubKeyBody);
    const addressBytes = hash.slice(-20);
    const address = `0x${Buffer.from(addressBytes).toString("hex")}`;

    allowance = {
      address,
      privateKey,
      created: new Date().toISOString(),
      funded: false,
      rail,
    };
    saveAllowance(allowance);
    allowanceCreated = true;
  } else {
    // Update rail if switching or missing
    if (allowance.rail !== rail) {
      allowance = { ...allowance, rail };
      saveAllowance(allowance);
    }
  }

  // 3. Faucet — request if not yet funded
  let faucetStatus = "skipped (already funded)";

  if (!allowance.funded) {
    if (rail === "mpp") {
      // Tempo Moderato faucet via JSON-RPC
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
      // x402 faucet via Run402 API
      const res = await apiRequest("/faucet/v1", {
        method: "POST",
        body: { address: allowance.address },
      });
      if (res.ok) {
        allowance = { ...allowance, funded: true, lastFaucet: new Date().toISOString() };
        saveAllowance(allowance);
        const body = res.body as { amount?: string; token?: string };
        faucetStatus = body.amount ? `funded (${body.amount} ${body.token || "USDC"})` : "funded";
      } else {
        const body = res.body as { error?: string; message?: string };
        faucetStatus = `failed: ${body.error || body.message || `HTTP ${res.status}`}`;
      }
    }
  }

  // 4. Tier status
  let tierDisplay = "(none)";
  const authHeaders = getAllowanceAuthHeaders("/tiers/v1/status");
  if (authHeaders) {
    const res = await apiRequest("/tiers/v1/status", {
      method: "GET",
      headers: { ...authHeaders },
    });
    if (res.ok) {
      const body = res.body as { tier?: string; active?: boolean; lease_expires_at?: string };
      if (body.tier && body.active) {
        const expiry = body.lease_expires_at ? body.lease_expires_at.split("T")[0] : "unknown";
        tierDisplay = `${body.tier} (expires ${expiry})`;
      }
    }
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
    lines.push(`**Ready to deploy.** Use \`bundle_deploy\` or \`provision_postgres_project\` to get started.`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
