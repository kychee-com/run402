import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const listProjectsSchema = {
  wallet: z
    .string()
    .describe(
      "Wallet address (0x...) to list projects for. Must be your own wallet — " +
        "the gateway requires SIWX matching this address (signed automatically " +
        "from the local allowance), so listing another wallet's projects returns 403.",
    ),
};

export async function handleListProjects(args: {
  wallet: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const wallet = args.wallet.toLowerCase();

  try {
    const body = await getSdk().projects.list(wallet);

    if (body.projects.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `## Projects for ${wallet}\n\n_No active projects found._`,
          },
        ],
      };
    }

    const lines = [
      `## Projects for ${wallet} (${body.projects.length})`,
      ``,
      `Tier and lifecycle live on the billing account, not on each project.`,
      `Call \`tier_status\` for the wallet's account tier, lifecycle state, and`,
      `pooled api_calls / storage_bytes across every project below.`,
      ``,
      `| ID | Name | API calls | Storage (bytes) | Created |`,
      `|----|------|----------:|----------------:|---------|`,
    ];

    for (const p of body.projects) {
      lines.push(
        `| \`${p.id}\` | ${p.name} | ${p.api_calls} | ${p.storage_bytes} | ${p.created_at} |`,
      );
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing projects");
  }
}
