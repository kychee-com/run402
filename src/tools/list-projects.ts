import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const listProjectsSchema = {
  wallet: z
    .string()
    .describe("Wallet address (0x...) to list projects for"),
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
      `| ID | Name | Tier | Status | Expires |`,
      `|----|------|------|--------|---------|`,
    ];

    for (const p of body.projects) {
      lines.push(
        `| \`${p.id}\` | ${p.name} | ${p.tier} | ${p.status} | ${p.lease_expires_at} |`,
      );
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing projects");
  }
}
