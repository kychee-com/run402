import { z } from "zod";
import { apiRequest } from "../client.js";
import { updateProject } from "../keystore.js";
import { formatApiError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const deploySiteSchema = {
  project: z
    .string()
    .describe("Project ID to link this deployment to"),
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
  inherit: z
    .boolean()
    .optional()
    .describe("If true, copy unchanged files from the previous deployment. Only include changed/new files in the files array."),
};

export async function handleDeploySite(args: {
  project: string;
  target?: string;
  files: Array<{ file: string; data: string; encoding?: string }>;
  inherit?: boolean;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/deployments/v1");
  if ("error" in auth) return auth.error;

  const res = await apiRequest("/deployments/v1", {
    method: "POST",
    headers: { ...auth.headers },
    body: {
      project: args.project,
      target: args.target,
      files: args.files,
      ...(args.inherit ? { inherit: true } : {}),
    },
  });

  if (!res.ok) return formatApiError(res, "deploying site");

  const body = res.body as {
    deployment_id: string;
    url: string;
  };

  // Store last deployment ID on the project
  updateProject(args.project, { last_deployment_id: body.deployment_id });

  const lines = [
    `## Site Deployed`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| deployment_id | \`${body.deployment_id}\` |`,
    `| url | ${body.url} |`,
    ``,
    `The site is live at **${body.url}**`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
