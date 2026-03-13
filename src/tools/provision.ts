import { z } from "zod";
import { apiRequest } from "../client.js";
import { saveProject } from "../keystore.js";
import { formatApiError } from "../errors.js";

export const provisionSchema = {
  tier: z
    .enum(["prototype", "hobby", "team"])
    .default("prototype")
    .describe("Database tier: prototype ($0.10/7d), hobby ($5/30d), team ($20/30d)"),
  name: z
    .string()
    .optional()
    .describe("Optional project name (auto-generated if omitted)"),
};

export async function handleProvision(args: {
  tier?: string;
  name?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const tier = args.tier || "prototype";
  const name = args.name;

  const res = await apiRequest("/projects/v1", {
    method: "POST",
    body: { tier, name },
  });

  if (res.is402) {
    const body = res.body as Record<string, unknown>;
    const lines = [
      `## Payment Required`,
      ``,
      `To provision a **${tier}** database, an x402 payment is needed.`,
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
    // Return as text (NOT isError) so the LLM can reason about payment
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (!res.ok) return formatApiError(res, "provisioning project");

  const body = res.body as {
    project_id: string;
    anon_key: string;
    service_key: string;
    tier: string;
    lease_expires_at: string;
    schema_slot: string;
  };

  // Save credentials to local key store
  saveProject(body.project_id, {
    anon_key: body.anon_key,
    service_key: body.service_key,
    tier: body.tier,
    expires_at: body.lease_expires_at,
  });

  const lines = [
    `## Project Provisioned`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| project_id | \`${body.project_id}\` |`,
    `| tier | ${body.tier} |`,
    `| schema | ${body.schema_slot} |`,
    `| expires | ${body.lease_expires_at} |`,
    ``,
    `Keys saved to local key store. You can now use \`run_sql\`, \`rest_query\`, and \`upload_file\` with this project.`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
