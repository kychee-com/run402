import { z } from "zod";
import { readAllowance } from "../allowance.js";
import { loadKeyStore, getActiveProjectId } from "../keystore.js";
import { getAllowanceAuthHeaders } from "../allowance-auth.js";
import { apiRequest } from "../client.js";

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
  const authHeaders = getAllowanceAuthHeaders("/tiers/v1/status");

  // Parallel API calls: tier + billing + server-side projects
  const [tierRes, balanceRes, projectsRes] = await Promise.all([
    authHeaders
      ? apiRequest("/tiers/v1/status", { method: "GET", headers: { ...authHeaders } }).catch(() => null)
      : Promise.resolve(null),
    apiRequest(`/billing/v1/accounts/${wallet}`, { method: "GET" }).catch(() => null),
    apiRequest(`/wallets/v1/${wallet}/projects`, { method: "GET" }).catch(() => null),
  ]);

  // Parse results
  const tier = tierRes?.ok
    ? (tierRes.body as { tier?: string; status?: string; lease_expires_at?: string })
    : null;
  const billing = balanceRes?.ok
    ? (balanceRes.body as { exists?: boolean; available_usd_micros?: number; held_usd_micros?: number })
    : null;
  const remote = projectsRes?.ok
    ? (projectsRes.body as { projects?: Array<{ id: string }> })
    : null;

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
  if (billing?.exists) {
    const available = ((billing.available_usd_micros ?? 0) / 1_000_000).toFixed(2);
    const held = ((billing.held_usd_micros ?? 0) / 1_000_000).toFixed(2);
    lines.push(`| balance | $${available} available, $${held} held |`);
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
