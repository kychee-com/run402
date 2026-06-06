import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { resolveProjectId } from "../active-project.js";

export const getSchemaSchema = {
  project_id: z.string().optional().describe("The project ID (defaults to the active project)"),
};

export async function handleGetSchema(args: {
  project_id?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = await resolveProjectId(args.project_id);
  if (typeof project !== "string") return project;
  try {
    const body = await getSdk().projects.getSchema(project);

    if (body.tables.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `## Schema: ${body.schema}\n\n_No tables found. Use \`run_sql\` to create tables._`,
          },
        ],
      };
    }

    const lines = [`## Schema: ${body.schema}`, ``];

    for (const table of body.tables) {
      lines.push(`### ${table.name}${table.rls_enabled ? " 🔒 RLS" : ""}`);
      lines.push(``);
      lines.push(`| Column | Type | Nullable | Default |`);
      lines.push(`|--------|------|----------|---------|`);
      for (const col of table.columns) {
        lines.push(
          `| ${col.name} | ${col.type} | ${col.nullable ? "YES" : "NO"} | ${col.default_value || "-"} |`,
        );
      }

      if (table.constraints.length > 0) {
        lines.push(``);
        lines.push(`**Constraints:** ${table.constraints.map((c) => `${c.type}(\`${c.name}\`)`).join(", ")}`);
      }

      if (table.policies.length > 0) {
        lines.push(``);
        lines.push(`**RLS Policies:**`);
        for (const p of table.policies) {
          lines.push(`- ${p.name} (${p.command})`);
        }
      }

      lines.push(``);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "fetching schema");
  }
}
