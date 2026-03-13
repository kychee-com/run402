import { z } from "zod";
import { apiRequest } from "../client.js";
import { saveProject } from "../keystore.js";
import { formatApiError } from "../errors.js";

export const forkAppSchema = {
  version_id: z.string().describe("The app version ID to fork (from browse_apps)"),
  name: z.string().describe("Name for the new forked project"),
  tier: z
    .enum(["prototype", "hobby", "team"])
    .default("prototype")
    .describe("Database tier: prototype ($0.10/7d), hobby ($5/30d), team ($20/30d)"),
  subdomain: z
    .string()
    .optional()
    .describe("Optional subdomain to claim for the forked app"),
};

export async function handleForkApp(args: {
  version_id: string;
  name: string;
  tier?: string;
  subdomain?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const tier = args.tier || "prototype";

  const res = await apiRequest(`/fork/v1/${tier}`, {
    method: "POST",
    body: {
      version_id: args.version_id,
      name: args.name,
      subdomain: args.subdomain,
    },
  });

  if (res.is402) {
    const body = res.body as Record<string, unknown>;
    const lines = [
      `## Payment Required`,
      ``,
      `To fork this app (tier: **${tier}**), an x402 payment is needed.`,
      ``,
    ];
    if (body.x402) {
      lines.push(`**Payment details:**`);
      lines.push("```json");
      lines.push(JSON.stringify(body.x402, null, 2));
      lines.push("```");
    } else {
      lines.push(`**Server response:**`);
      lines.push("```json");
      lines.push(JSON.stringify(body, null, 2));
      lines.push("```");
    }
    lines.push(``);
    lines.push(
      `The user's wallet or payment agent must send the required amount. ` +
      `Once payment is confirmed, retry this tool call.`,
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (!res.ok) return formatApiError(res, "forking app");

  const body = res.body as {
    project_id: string;
    anon_key: string;
    service_key: string;
    schema_slot: string;
    tier: string;
    lease_expires_at: string;
    site_url?: string;
    subdomain_url?: string;
    functions?: Array<{ name: string; url: string }>;
  };

  // Save credentials to local key store
  saveProject(body.project_id, {
    anon_key: body.anon_key,
    service_key: body.service_key,
    tier: body.tier,
    expires_at: body.lease_expires_at,
  });

  const lines = [
    `## App Forked: ${args.name}`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| project_id | \`${body.project_id}\` |`,
    `| tier | ${body.tier} |`,
    `| schema | ${body.schema_slot} |`,
    `| expires | ${body.lease_expires_at} |`,
  ];

  if (body.site_url) {
    lines.push(`| site | ${body.site_url} |`);
  }
  if (body.subdomain_url) {
    lines.push(`| subdomain | ${body.subdomain_url} |`);
  }

  lines.push(``);
  lines.push(`Keys saved to local key store.`);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
