import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError, projectNotFound } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";
import { PaymentRequired } from "../../sdk/dist/index.js";
import type { RlsTemplate } from "../../sdk/dist/namespaces/projects.types.js";

// Refined rls schema for pre-network validation.
// MCP SDK accepts only raw shapes, so the refinement runs at the handler boundary.
// Exported for unit tests.
export const bundleDeployRlsRefined = z
  .object({
    template: z.enum([
      "user_owns_rows",
      "public_read_authenticated_write",
      "public_read_write_UNRESTRICTED",
    ]),
    tables: z.array(
      z.object({
        table: z.string(),
        owner_column: z.string().optional(),
      }),
    ),
    i_understand_this_is_unrestricted: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.template === "public_read_write_UNRESTRICTED" &&
      data.i_understand_this_is_unrestricted !== true
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["i_understand_this_is_unrestricted"],
        message:
          "i_understand_this_is_unrestricted must be true when template is public_read_write_UNRESTRICTED",
      });
    }
  });

export const bundleDeploySchema = {
  project_id: z.string().describe("Project ID to deploy to (from provision). Uses active project if omitted.").optional(),
  migrations: z
    .string()
    .optional()
    .describe("SQL migrations to run (CREATE TABLE statements, etc.)"),
  rls: z
    .object({
      template: z.enum([
        "user_owns_rows",
        "public_read_authenticated_write",
        "public_read_write_UNRESTRICTED",
      ]),
      tables: z.array(
        z.object({
          table: z.string(),
          owner_column: z.string().optional(),
        }),
      ),
      i_understand_this_is_unrestricted: z
        .boolean()
        .optional()
        .describe(
          "Required to be true when template is public_read_write_UNRESTRICTED. Ignored otherwise.",
        ),
    })
    .optional()
    .describe(
      "⚠ DEPRECATED (sunset 2026-05-23) — prefer a `manifest.json` entry in `files[]`. " +
      "The gateway auto-translates this block to a manifest during the deprecation window. " +
      "Templates: user_owns_rows, public_read_authenticated_write, public_read_write_UNRESTRICTED " +
      "(requires i_understand_this_is_unrestricted: true).",
    ),
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
        schedule: z
          .string()
          .optional()
          .describe("Cron expression (5-field) to run the function on a schedule"),
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
    .describe(
      "Static site files to deploy (must include index.html). May include a `manifest.json` entry " +
      "to declare the authorization surface (tables/views/RPCs reachable via PostgREST). The gateway " +
      "reads it, validates against the migrations, applies it, and strips it from `files[]` before " +
      "the site deploys. Schema: https://run402.com/schemas/manifest.v1.json.",
    ),
  subdomain: z
    .string()
    .optional()
    .describe("Custom subdomain to claim (e.g. 'myapp' → myapp.run402.com)"),
  inherit: z
    .boolean()
    .optional()
    .describe("If true, copy unchanged site files from the previous deployment. Only include changed/new files."),
};

export async function handleBundleDeploy(args: {
  project_id?: string;
  migrations?: string;
  rls?: {
    template: string;
    tables: Array<{ table: string; owner_column?: string }>;
    i_understand_this_is_unrestricted?: boolean;
  };
  secrets?: Array<{ key: string; value: string }>;
  functions?: Array<{ name: string; code: string; config?: { timeout?: number; memory?: number }; schedule?: string }>;
  files?: Array<{ file: string; data: string; encoding?: string }>;
  subdomain?: string;
  inherit?: boolean;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const projectId = args.project_id;
  if (!projectId) return projectNotFound("(none — project_id is required)");

  if (args.rls) {
    const parsed = bundleDeployRlsRefined.safeParse(args.rls);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `rls.${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return {
        content: [{ type: "text", text: `Validation error: ${issues}` }],
        isError: true,
      };
    }
  }

  const auth = requireAllowanceAuth("/deploy/v1");
  if ("error" in auth) return auth.error;

  try {
    const body = await getSdk().apps.bundleDeploy(projectId, {
      migrations: args.migrations,
      rls: args.rls
        ? {
            template: args.rls.template as RlsTemplate,
            tables: args.rls.tables,
            i_understand_this_is_unrestricted: args.rls.i_understand_this_is_unrestricted,
          }
        : undefined,
      secrets: args.secrets,
      functions: args.functions,
      files: args.files as Array<{ file: string; data: string; encoding?: "utf-8" | "base64" }> | undefined,
      subdomain: args.subdomain,
      inherit: args.inherit,
    });

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
        const sched = fn.schedule ? ` (${fn.schedule})` : "";
        lines.push(`- \`${fn.name}\` → ${fn.url}${sched}`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    if (err instanceof PaymentRequired) {
      const body = (err.body ?? {}) as Record<string, unknown>;
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
    return mapSdkError(err, "deploying bundle");
  }
}
