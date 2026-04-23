import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";
import { PaymentRequired } from "../../sdk/dist/index.js";

export const provisionSchema = {
  tier: z
    .enum(["prototype", "hobby", "team"])
    .default("prototype")
    .describe("Database tier: prototype ($0.10/7d), hobby ($5/30d), team ($20/30d)"),
  name: z
    .string()
    .optional()
    .describe("Optional project name (auto-generated if omitted)"),
};

export async function handleProvision(args: {
  tier?: string;
  name?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/projects/v1");
  if ("error" in auth) return auth.error;

  const tier = args.tier || "prototype";
  const name = args.name;

  try {
    const body = await getSdk().projects.provision({
      tier: tier as "prototype" | "hobby" | "team",
      name,
    });

    const lines = [
      `## Project Provisioned`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| project_id | \`${body.project_id}\` |`,
      `| schema | ${body.schema_slot} |`,
      ``,
      `Keys saved to local key store. You can now use \`run_sql\`, \`rest_query\`, and \`upload_file\` with this project.`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    if (err instanceof PaymentRequired) {
      const body = (err.body ?? {}) as Record<string, unknown>;
      const lines = [
        `## Payment Required`,
        ``,
        `To provision a **${tier}** project, an x402 payment is needed.`,
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
    return mapSdkError(err, "provisioning project");
  }
}
