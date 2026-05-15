import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const updateFunctionSchema = {
  project_id: z.string().describe("The project ID"),
  name: z.string().describe("Function name to update"),
  schedule: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Cron expression (5-field, e.g. '*/15 * * * *') to set or update the schedule. Pass null to remove an existing schedule.",
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .safe()
    .optional()
    .describe("Timeout in seconds (tier limits apply)"),
  memory: z
    .number()
    .int()
    .positive()
    .safe()
    .optional()
    .describe("Memory in MB (tier limits apply)"),
};

export async function handleUpdateFunction(args: {
  project_id: string;
  name: string;
  schedule?: string | null;
  timeout?: number;
  memory?: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await getSdk().functions.update(args.project_id, args.name, {
      schedule: args.schedule,
      timeout: args.timeout,
      memory: args.memory,
    });

    const lines = [
      `## Function Updated`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| name | \`${result.name}\` |`,
      `| runtime | ${result.runtime} |`,
      `| timeout | ${result.timeout}s |`,
      `| memory | ${result.memory}MB |`,
      `| schedule | ${result.schedule ? `\`${result.schedule}\`` : "—"} |`,
      `| updated_at | ${result.updated_at} |`,
    ];

    if (result.runtime_version != null) {
      lines.push(`| Functions runtime version | \`@run402/functions@${result.runtime_version}\` |`);
    }

    if (result.deps_resolved) {
      const entries = Object.entries(result.deps_resolved);
      if (entries.length > 0) {
        lines.push(``, `**Resolved deps:**`);
        for (const [name, version] of entries) {
          lines.push(`- \`${name}@${version}\``);
        }
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "updating function");
  }
}
