import { readRemoteStatus } from "../../sdk/dist/node/index.js";
import { readWallet } from "../wallet.js";
import { loadKeyStore, getActiveProjectId } from "../keystore.js";
import { getActiveProfile, readMeta } from "../config.js";
import { getSdk } from "../sdk.js";

export const statusSchema = {};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleStatus(
  _args: Record<string, never>,
): Promise<McpResult> {
  // readWallet throws on a malformed-shape file — translate to a
  // friendly MCP error rather than crashing with a noble-curves stack trace.
  let localWallet;
  try {
    localWallet = readWallet();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: `Wallet file is malformed: ${msg}`,
        },
      ],
      isError: true,
    };
  }
  if (!localWallet) {
    return {
      content: [
        {
          type: "text",
          text: "No local wallet found. Use `init` or `wallet_create` to create one.",
        },
      ],
      isError: true,
    };
  }

  const wallet = localWallet.address.toLowerCase();
  const sdk = getSdk();

  // Parallel SDK calls — each swallowed to a best-effort null so missing
  // data doesn't block the summary.
  const { tier, billing, remote, availability, next_actions } = await readRemoteStatus(sdk, wallet);

  // Local keystore
  const store = loadKeyStore();
  const activeId = getActiveProjectId();
  const projects = remote?.projects || Object.keys(store.projects).map((id) => ({ id }));

  // Active named wallet (from RUN402_WALLET in the MCP server env, else default).
  const walletName = getActiveProfile();
  const walletMeta = readMeta(walletName);
  const rail = localWallet.rail || "x402";

  // Build summary
  const lines: string[] = [
    `## Organization Status`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| local_label | ${walletName} |`,
    `| server_label | ${walletMeta?.label ?? "(none)"} |`,
    `| address | \`${localWallet.address}\` |`,
    `| rail | ${rail} |`,
  ];

  // The organization's allowance (Run402-held, rail-independent). The
  // on-chain wallet balance is not read here — use `run402 status` (CLI) for
  // that figure.
  if (billing) {
    const allowanceUsd = (billing.allowance_usd_micros / 1_000_000).toFixed(2);
    const held = ((billing.held_usd_micros ?? 0) / 1_000_000).toFixed(2);
    lines.push(`| allowance | $${allowanceUsd} |`);
    lines.push(`| held | $${held} |`);
  } else {
    lines.push(`| allowance | (unavailable) |`);
  }

  // Tier
  if (tier?.tier) {
    const expiry = tier.lease_expires_at ? tier.lease_expires_at.split("T")[0] : "unknown";
    const state = tier.active ? "active" : "inactive";
    lines.push(`| tier | ${tier.tier} (${state}, expires ${expiry}) |`);
  } else {
    lines.push(`| tier | ${availability.tier?.state === "unavailable" ? "(unavailable)" : "(none)"} |`);
  }

  // Projects
  lines.push(`| projects | ${projects.length} |`);
  lines.push(`| active | ${activeId ? `\`${activeId}\`` : "(none)"} |`);

  // Project list
  if (projects.length > 0) {
    lines.push(``);
    lines.push(`### Projects`);
    for (const p of projects) {
      const marker = p.id === activeId ? " **(active)**" : "";
      lines.push(`- \`${p.id}\`${marker}`);
    }
  }

  // Next step
  if (!tier?.tier && availability.tier?.state !== "unavailable") {
    lines.push(``);
    lines.push(`**Next:** Use \`tier_set\` to set a tier (prototype is free).`);
  }

  if (next_actions.length) lines.push("", next_actions[0]!.why);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
