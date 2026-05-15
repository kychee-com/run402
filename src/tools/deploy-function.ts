import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { PaymentRequired } from "../../sdk/dist/index.js";

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
      timeout: z.number().int().positive().safe().optional().describe("Timeout in seconds (default: tier max)"),
      memory: z.number().int().positive().safe().optional().describe("Memory in MB (default: tier max)"),
    })
    .optional()
    .describe("Optional function configuration"),
  deps: z
    .array(z.string())
    .optional()
    .describe(
      "Optional npm package specs to install and bundle. Bare names (e.g. 'lodash') resolve to latest at deploy time; pinned (e.g. 'lodash@4.17.21') or range specs ('date-fns@^3.0.0') are honored verbatim. '@run402/functions' (auto-bundled) and 'run402-functions' (legacy name) are rejected. Max 30 entries, max 200 chars per spec. Native binary modules (sharp, canvas, native bcrypt, etc.) are rejected.",
    ),
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
  try {
    const body = await getSdk().functions.deploy(args.project_id, {
      name: args.name,
      code: args.code,
      config: args.config,
      deps: args.deps,
      schedule: args.schedule,
    });

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
    ];

    if (body.runtime_version != null) {
      lines.push(`| Functions runtime version | \`@run402/functions@${body.runtime_version}\` |`);
    }

    if (body.deps_resolved) {
      const entries = Object.entries(body.deps_resolved);
      if (entries.length === 0) {
        lines.push(``, `**Resolved deps:** _none_`);
      } else {
        lines.push(``, `**Resolved deps:**`);
        for (const [name, version] of entries) {
          lines.push(`- \`${name}@${version}\``);
        }
      }
    }

    if (body.warnings && body.warnings.length > 0) {
      lines.push(``, `### Warnings`);
      for (const warning of body.warnings) {
        lines.push(`- ${warning}`);
      }
    }

    lines.push(
      ``,
      `The function is live at **${body.url}**`,
      ``,
      `Invoke with: \`invoke_function(project_id: "${args.project_id}", name: "${body.name}")\``,
    );

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    if (err instanceof PaymentRequired) {
      const body = (err.body ?? {}) as Record<string, unknown>;
      return {
        content: [
          {
            type: "text",
            text: `## Payment Required\n\nProject lease expired. Renew to continue deploying functions.\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``,
          },
        ],
      };
    }
    return mapSdkError(err, "deploying function");
  }
}
