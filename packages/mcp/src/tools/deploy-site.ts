import { z } from "zod";
import { apiRequest } from "../client.js";

export const deploySiteSchema = {
  name: z
    .string()
    .describe("Site name (e.g. 'family-todo', 'portfolio')"),
  project: z
    .string()
    .optional()
    .describe("Optional project ID to link this deployment to an existing Run402 project"),
  target: z
    .string()
    .optional()
    .describe("Deployment target (e.g. 'production'). Tracked in DB for future alias support."),
  files: z
    .array(
      z.object({
        file: z.string().describe("File path (e.g. 'index.html', 'assets/logo.png')"),
        data: z.string().describe("File content (text or base64-encoded)"),
        encoding: z
          .enum(["utf-8", "base64"])
          .optional()
          .describe("Encoding: 'utf-8' (default) for text, 'base64' for binary files"),
      }),
    )
    .describe("Array of files to deploy. Must include at least index.html."),
};

export async function handleDeploySite(args: {
  name: string;
  project?: string;
  target?: string;
  files: Array<{ file: string; data: string; encoding?: string }>;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const res = await apiRequest("/v1/deployments", {
    method: "POST",
    body: {
      name: args.name,
      project: args.project,
      target: args.target,
      files: args.files,
    },
  });

  if (res.is402) {
    const body = res.body as Record<string, unknown>;
    const lines = [
      `## Payment Required`,
      ``,
      `To deploy a static site, an x402 payment of **$0.05 USDC** is needed.`,
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

  if (!res.ok) {
    const body = res.body as Record<string, unknown>;
    const msg = (body.error as string) || `HTTP ${res.status}`;
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
  }

  const body = res.body as {
    id: string;
    name: string;
    url: string;
    project_id: string | null;
    status: string;
    created_at: string;
    files_count: number;
    total_size: number;
  };

  const lines = [
    `## Site Deployed`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| id | \`${body.id}\` |`,
    `| url | ${body.url} |`,
    `| status | ${body.status} |`,
    `| files | ${body.files_count} |`,
    `| size | ${(body.total_size / 1024).toFixed(1)} KB |`,
    ``,
    `The site is live at **${body.url}**`,
  ];

  if (body.project_id) {
    lines.push(`Linked to project \`${body.project_id}\``);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
