import { z } from "zod";
import { paidApiRequest } from "../paid-fetch.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const deployFunctionSchema = {
  project_id: z.string().describe("The project ID to deploy the function to"),
  name: z
    .string()
    .describe("Function name (URL-safe slug: lowercase, hyphens, alphanumeric, e.g. 'stripe-webhook')"),
  code: z
    .string()
    .describe("TypeScript or JavaScript source code. Must export a default async function: export default async (req: Request) => Response"),
  config: z
    .object({
      timeout: z.number().optional().describe("Timeout in seconds (default: tier max)"),
      memory: z.number().optional().describe("Memory in MB (default: tier max)"),
    })
    .optional()
    .describe("Optional function configuration"),
  deps: z
    .array(z.string())
    .optional()
    .describe("Optional npm packages to install alongside pre-bundled packages"),
  schedule: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Cron expression (5-field, e.g. '*/15 * * * *') to run the function on a schedule. Pass null to remove an existing schedule.",
    ),
};

export async function handleDeployFunction(args: {
  project_id: string;
  name: string;
  code: string;
  config?: { timeout?: number; memory?: number };
  deps?: string[];
  schedule?: string | null;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await paidApiRequest(`/projects/v1/admin/${args.project_id}/functions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
    body: {
      name: args.name,
      code: args.code,
      config: args.config,
      deps: args.deps,
      ...(args.schedule !== undefined ? { schedule: args.schedule } : {}),
    },
  });

  if (res.is402) {
    const body = res.body as Record<string, unknown>;
    return {
      content: [
        {
          type: "text",
          text: `## Payment Required\n\nProject lease expired. Renew to continue deploying functions.\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``,
        },
      ],
    };
  }

  if (!res.ok) return formatApiError(res, "deploying function");

  const body = res.body as {
    name: string;
    url: string;
    status: string;
    runtime: string;
    timeout: number;
    memory: number;
    schedule?: string | null;
    created_at: string;
  };

  const lines = [
    `## Function Deployed`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| name | \`${body.name}\` |`,
    `| url | ${body.url} |`,
    `| status | ${body.status} |`,
    `| runtime | ${body.runtime} |`,
    `| timeout | ${body.timeout}s |`,
    `| memory | ${body.memory}MB |`,
    `| schedule | ${body.schedule ? `\`${body.schedule}\`` : "—"} |`,
    ``,
    `The function is live at **${body.url}**`,
    ``,
    `Invoke with: \`invoke_function(project_id: "${args.project_id}", name: "${body.name}")\``,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
