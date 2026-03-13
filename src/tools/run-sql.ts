import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const runSqlSchema = {
  project_id: z.string().describe("The project ID to run SQL against"),
  sql: z.string().describe("SQL statement to execute (DDL or DML)"),
};

function formatMarkdownTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "_0 rows returned_";

  const columns = Object.keys(rows[0]!);
  const header = `| ${columns.join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (row) => `| ${columns.map((c) => String(row[c] ?? "NULL")).join(" | ")} |`,
  );

  return [header, separator, ...body].join("\n");
}

export async function handleRunSql(args: {
  project_id: string;
  sql: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/projects/v1/admin/${args.project_id}/sql`, {
    method: "POST",
    rawBody: args.sql,
    headers: {
      "Content-Type": "text/plain",
      Authorization: `Bearer ${project.service_key}`,
    },
  });

  if (!res.ok) return formatApiError(res, "running SQL");

  const body = res.body as {
    status: string;
    schema: string;
    rows: Record<string, unknown>[];
    rowCount: number | null;
  };

  const table = formatMarkdownTable(body.rows);
  const lines = [
    `**${body.rows.length} row${body.rows.length !== 1 ? "s" : ""} returned** (schema: ${body.schema})`,
    ``,
    table,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
