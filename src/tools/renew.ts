import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject, saveProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const renewSchema = {
  project_id: z.string().describe("The project ID to renew"),
  tier: z
    .enum(["prototype", "hobby", "team"])
    .optional()
    .describe("Tier for renewal (defaults to current tier)"),
};

export async function handleRenew(args: {
  project_id: string;
  tier?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const tier = args.tier || project.tier;

  const res = await apiRequest(`/projects/v1/${args.project_id}/renew`, {
    method: "POST",
    body: { tier },
  });

  if (res.is402) {
    const body = res.body as Record<string, unknown>;
    const lines = [
      `## Payment Required`,
      ``,
      `To renew project \`${args.project_id}\` (tier: **${tier}**), an x402 payment is needed.`,
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

  if (!res.ok) return formatApiError(res, "renewing project");

  const body = res.body as {
    project_id: string;
    tier: string;
    lease_expires_at: string;
  };

  // Update key store with new expiry
  saveProject(args.project_id, {
    ...project,
    tier: body.tier,
    expires_at: body.lease_expires_at,
  });

  return {
    content: [
      {
        type: "text",
        text: `Project \`${body.project_id}\` renewed. New expiry: **${body.lease_expires_at}**`,
      },
    ],
  };
}
