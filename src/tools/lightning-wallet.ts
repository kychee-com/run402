import { z } from "zod";
import { readAllowance, saveAllowance } from "../allowance.js";
import { mapSdkError } from "../errors.js";
import { getSdk } from "../sdk.js";
import type { AgentLightningWallet } from "../../sdk/dist/index.js";

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export const lightningWalletSchema = {
  action: z
    .enum(["mint", "get", "revoke"])
    .optional()
    .describe("mint (default): ask Run402 for the agent's Lightning wallet and store its pairing locally; get: read it; revoke: delete it on Run402's Hub and forget the pairing"),
};

function render(wallet: AgentLightningWallet, title: string, extra: string[] = []): string {
  return [
    `## ${title}`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| wallet_id | \`${wallet.wallet_id}\` |`,
    `| status | ${wallet.status} |`,
    `| custody | ${wallet.custody} — the sats sit on Run402's Lightning Hub; this is a budgeted connection, not self-custody |`,
    `| lightning_address | ${wallet.lightning_address ?? "-"} |`,
    `| budget_sats | ${wallet.budget_sats} |`,
    `| starter_sats | ${wallet.starter_sats} |`,
    `| has_pairing | ${wallet.has_pairing ? "yes" : "no"} |`,
    ...extra,
  ].join("\n");
}

/**
 * The Lightning allowance: one budgeted, isolated sub-wallet per agent on
 * Run402's Hub. `mint` stores the one-time pairing in the local allowance
 * (never in the tool output) and makes Lightning the default rail.
 */
export async function handleLightningWallet(args: { action?: "mint" | "get" | "revoke" }): Promise<McpResult> {
  const action = args.action ?? "mint";
  try {
    if (action === "get") {
      const wallet = await getSdk().agent.lightningWallet.get();
      const local = readAllowance();
      const held = Boolean(local?.lightning?.nwc);
      return { content: [{ type: "text", text: render(wallet, "Lightning wallet", [
        `| pairing_on_this_machine | ${held ? "yes" : "no"} |`,
        ...(wallet.status === "minting" ? [``, `Still minting — call \`lightning_wallet\` with action \`mint\` again in a few seconds.`] : []),
      ]) }] };
    }
    if (action === "revoke") {
      const wallet = await getSdk().agent.lightningWallet.revoke();
      const local = readAllowance();
      if (local) {
        const { lightning: _dropped, ...rest } = local;
        saveAllowance({ ...rest, rail: rest.rail === "lightning" ? "x402" : rest.rail });
      }
      return { content: [{ type: "text", text: render(wallet, "Lightning wallet revoked", [``, `The rail is back on x402. Mint again with \`lightning_wallet\` once the deletion completes.`]) }] };
    }
    let local = readAllowance();
    if (!local) {
      return { content: [{ type: "text", text: "No allowance yet. Run `init` first (it creates the Base allowance the Lightning wallet sits beside)." }], isError: true };
    }
    if (local.lightning?.nwc) {
      const wallet = await getSdk().agent.lightningWallet.get();
      return { content: [{ type: "text", text: render(wallet, "Lightning wallet (already held)", [``, `The pairing is stored locally; Lightning is the default rail for paid calls.`]) }] };
    }
    const wallet = await getSdk().agent.lightningWallet.mint({ timeoutMs: 45_000 });
    if (wallet.status === "minting") {
      return { content: [{ type: "text", text: render(wallet, "Lightning wallet (minting)", [``, `The platform is still minting it. Call \`lightning_wallet\` again in a few seconds.`]) }] };
    }
    if (wallet.status !== "active") {
      return { content: [{ type: "text", text: render(wallet, `Lightning wallet (${wallet.status})`, [``, `Reason: ${wallet.failure_reason ?? "-"}`]) }], isError: wallet.status === "failed" };
    }
    if (typeof wallet.pairing !== "string") {
      return { content: [{ type: "text", text: render(wallet, "Lightning wallet (pairing already handed out)", [``, `The one-time pairing went to another machine. Revoke (action \`revoke\`) and mint again to pay from here.`]) }], isError: true };
    }
    local = {
      ...local,
      rail: "lightning",
      lightning: {
        wallet_id: wallet.wallet_id,
        nwc: wallet.pairing,
        lightning_address: wallet.lightning_address,
        budget_sats: wallet.budget_sats,
        starter_sats: wallet.starter_sats,
        custody: "run402_hub",
        minted_at: wallet.activated_at ?? new Date().toISOString(),
      },
    };
    saveAllowance(local);
    return { content: [{ type: "text", text: render(wallet, "Lightning wallet minted", [``, `The pairing is stored locally (never shown). Lightning is now the default rail: paid calls answer a Lightning challenge first and fall back to x402.`]) }] };
  } catch (err) {
    return mapSdkError(err, `${action === "get" ? "reading" : action === "revoke" ? "revoking" : "minting"} the Lightning wallet`);
  }
}
