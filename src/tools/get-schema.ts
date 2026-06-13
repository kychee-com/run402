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
        lines.push(`**Constraints:**`);
        for (const c of table.constraints) {
          // Render the full definition, not just type+name — FK targets
          // (REFERENCES …) and CHECK predicates are what an agent needs to
          // reason about joins and valid inserts without a follow-up query.
          lines.push(`- ${c.type} \`${c.name}\`: ${c.definition}`);
        }
      }

      if (table.policies.length > 0) {
        lines.push(``);
        lines.push(`**RLS Policies:**`);
        for (const p of table.policies) {
          // Surface the USING / WITH CHECK predicates, not just the policy
          // name — the predicate is what determines which rows the agent can
          // read and write under RLS.
          const parts = [`${p.name} (${p.command})`];
          if (p.using_expression) parts.push(`USING ${p.using_expression}`);
          if (p.check_expression) parts.push(`WITH CHECK ${p.check_expression}`);
          lines.push(`- ${parts.join(" — ")}`);
        }
      }

      lines.push(``);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "fetching schema");
  }
}
