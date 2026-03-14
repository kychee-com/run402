import { z } from "zod";
import { apiRequest } from "../client.js";
import { saveProject } from "../keystore.js";
import { formatApiError } from "../errors.js";

export const bundleDeploySchema = {
  name: z.string().describe("App name (used as project name and default subdomain)"),
  migrations: z
    .string()
    .optional()
    .describe("SQL migrations to run after provisioning (CREATE TABLE statements, etc.)"),
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
  site: z
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
  name: string;
  migrations?: string;
  rls?: { template: string; tables: Array<{ table: string; owner_column?: string }> };
  secrets?: Array<{ key: string; value: string }>;
  functions?: Array<{ name: string; code: string; config?: { timeout?: number; memory?: number } }>;
  site?: Array<{ file: string; data: string; encoding?: string }>;
  subdomain?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const res = await apiRequest("/deploy/v1", {
    method: "POST",
    body: {
      name: args.name,
      migrations: args.migrations,
      rls: args.rls,
      secrets: args.secrets,
      functions: args.functions,
      site: args.site,
      subdomain: args.subdomain,
    },
  });

  if (res.is402) {
    const body = res.body as Record<string, unknown>;
    const lines = [
      `## Payment Required`,
      ``,
      `To bundle-deploy **${args.name}**, an x402 payment is needed.`,
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

  if (!res.ok) return formatApiError(res, "deploying bundle");

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
    `## Bundle Deployed: ${args.name}`,
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

  if (body.functions && body.functions.length > 0) {
    lines.push(``);
    lines.push(`**Functions:**`);
    for (const fn of body.functions) {
      lines.push(`- \`${fn.name}\` → ${fn.url}`);
    }
  }

  lines.push(``);
  lines.push(`Keys saved to local key store.`);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
