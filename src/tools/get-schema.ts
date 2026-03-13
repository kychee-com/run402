import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const getSchemaSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleGetSchema(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/projects/v1/admin/${args.project_id}/schema`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
  });

  if (!res.ok) return formatApiError(res, "fetching schema");

  const body = res.body as {
    schema: string;
    tables: Array<{
      name: string;
      columns: Array<{
        name: string;
        type: string;
        nullable: boolean;
        default_value: string | null;
      }>;
      constraints: Array<{
        name: string;
        type: string;
        definition: string;
      }>;
      rls_enabled: boolean;
      policies: Array<{
        name: string;
        command: string;
        using_expression: string | null;
        check_expression: string | null;
      }>;
    }>;
  };

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
}
