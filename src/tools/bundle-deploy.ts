import { z } from "zod";
import { paidApiRequest } from "../paid-fetch.js";
import { formatApiError, projectNotFound } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";
import { getProject } from "../keystore.js";

export const bundleDeploySchema = {
  project_id: z.string().describe("Project ID to deploy to (from provision). Uses active project if omitted.").optional(),
  migrations: z
    .string()
    .optional()
    .describe("SQL migrations to run (CREATE TABLE statements, etc.)"),
  rls: z
    .object({
      template: z.enum(["user_owns_rows", "public_read", "public_read_write"]),
      tables: z.array(
        z.object({
          table: z.string(),
          owner_column: z.string().optional(),
        }),
      ),
    })
    .optional()
    .describe("RLS configuration to apply after migrations"),
  secrets: z
    .array(z.object({ key: z.string(), value: z.string() }))
    .optional()
    .describe("Secrets to set (e.g. [{key: 'STRIPE_SECRET_KEY', value: 'sk_...'}])"),
  functions: z
    .array(
      z.object({
        name: z.string(),
        code: z.string(),
        config: z
          .object({
            timeout: z.number().optional(),
            memory: z.number().optional(),
          })
          .optional(),
      }),
    )
    .optional()
    .describe("Functions to deploy"),
  files: z
    .array(
      z.object({
        file: z.string(),
        data: z.string(),
        encoding: z.enum(["utf-8", "base64"]).optional(),
      }),
    )
    .optional()
    .describe("Static site files to deploy (must include index.html)"),
  subdomain: z
    .string()
    .optional()
    .describe("Custom subdomain to claim (e.g. 'myapp' → myapp.run402.com)"),
};

export async function handleBundleDeploy(args: {
  project_id?: string;
  migrations?: string;
  rls?: { template: string; tables: Array<{ table: string; owner_column?: string }> };
  secrets?: Array<{ key: string; value: string }>;
  functions?: Array<{ name: string; code: string; config?: { timeout?: number; memory?: number } }>;
  files?: Array<{ file: string; data: string; encoding?: string }>;
  subdomain?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const projectId = args.project_id;
  if (!projectId) return projectNotFound("(none — project_id is required)");
  const project = getProject(projectId);
  if (!project) return projectNotFound(projectId);

  const auth = requireAllowanceAuth("/deploy/v1");
  if ("error" in auth) return auth.error;

  const res = await paidApiRequest("/deploy/v1", {
    method: "POST",
    headers: { ...auth.headers },
    body: {
      project_id: projectId,
      migrations: args.migrations,
      rls: args.rls,
      secrets: args.secrets,
      functions: args.functions,
      files: args.files,
      subdomain: args.subdomain,
    },
  });

  if (res.is402) {
    const body = res.body as Record<string, unknown>;
    const lines = [
      `## Payment Required`,
      ``,
      `To deploy this bundle, an x402 payment is needed.`,
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
      `The user's agent allowance or payment agent must send the required amount. ` +
      `Once payment is confirmed, retry this tool call.`,
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (!res.ok) return formatApiError(res, "deploying bundle");

  const body = res.body as {
    project_id: string;
    migrations_result?: {
      tables_created: string[];
      columns_added: string[];
      status: string;
    };
    site_url?: string;
    deployment_id?: string;
    functions?: Array<{ name: string; url: string }>;
    subdomain_url?: string;
  };

  const lines = [
    `## Bundle Deployed`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| project_id | \`${body.project_id}\` |`,
  ];

  if (body.site_url) {
    lines.push(`| site | ${body.site_url} |`);
  }
  if (body.subdomain_url) {
    lines.push(`| subdomain | ${body.subdomain_url} |`);
  }
  if (body.deployment_id) {
    lines.push(`| deployment_id | \`${body.deployment_id}\` |`);
  }

  if (body.migrations_result) {
    const mr = body.migrations_result;
    if (mr.status === "no_changes") {
      lines.push(``, `**Migrations:** schema unchanged`);
    } else {
      const parts: string[] = [];
      if (mr.tables_created.length > 0) {
        parts.push(`tables created: ${mr.tables_created.map((t) => `\`${t}\``).join(", ")}`);
      }
      if (mr.columns_added.length > 0) {
        parts.push(`columns added: ${mr.columns_added.map((c) => `\`${c}\``).join(", ")}`);
      }
      lines.push(``, `**Migrations:** ${parts.join("; ")}`);
    }
  }

  if (body.functions && body.functions.length > 0) {
    lines.push(``);
    lines.push(`**Functions:**`);
    for (const fn of body.functions) {
      lines.push(`- \`${fn.name}\` → ${fn.url}`);
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
