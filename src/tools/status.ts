import { readAllowance } from "../allowance.js";
import { loadKeyStore, getActiveProjectId } from "../keystore.js";
import { getSdk } from "../sdk.js";

export const statusSchema = {};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleStatus(
  _args: Record<string, never>,
): Promise<McpResult> {
  const allowance = readAllowance();
  if (!allowance) {
    return {
      content: [
        {
          type: "text",
          text: "No agent allowance found. Use `init` or `allowance_create` to create one.",
        },
      ],
      isError: true,
    };
  }

  const wallet = allowance.address.toLowerCase();
  const sdk = getSdk();

  // Parallel SDK calls — each swallowed to a best-effort null so missing
  // data doesn't block the summary.
  const [tier, billing, remote] = await Promise.all([
    sdk.tier.status().catch(() => null),
    sdk.billing.checkBalance(wallet).catch(() => null),
    sdk.projects.list(wallet).catch(() => null),
  ]);

  // Local keystore
  const store = loadKeyStore();
  const activeId = getActiveProjectId();
  const projects = remote?.projects || Object.keys(store.projects).map((id) => ({ id }));

  // Build summary
  const lines: string[] = [
    `## Account Status`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| allowance | \`${allowance.address}\` |`,
    `| funded | ${allowance.funded ? "yes" : "no"} |`,
    `| rail | ${allowance.rail || "x402"} |`,
  ];

  // Balance
  if (billing) {
    const available = (billing.available_usd_micros / 1_000_000).toFixed(2);
    lines.push(`| balance | $${available} available |`);
  } else {
    lines.push(`| balance | (unavailable) |`);
  }

  // Tier
  if (tier?.tier) {
    const expiry = tier.lease_expires_at ? tier.lease_expires_at.split("T")[0] : "unknown";
    lines.push(`| tier | ${tier.tier} (${tier.status}, expires ${expiry}) |`);
  } else {
    lines.push(`| tier | (none) |`);
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
  if (!tier?.tier) {
    lines.push(``);
    lines.push(`**Next:** Use \`set_tier\` to subscribe to a tier.`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
