import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const runSqlSchema = {
  project_id: z.string().describe("The project ID to run SQL against"),
  sql: z.string().describe("SQL statement to execute (DDL or DML)"),
  params: z.array(z.unknown()).optional().describe("Bind parameters for parameterized queries (e.g. [42, \"hello\"])"),
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
  params?: unknown[];
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  let body: {
    status: string;
    schema: string;
    rows: Record<string, unknown>[];
    rowCount: number | null;
  };
  try {
    body = await getSdk().projects.sql(args.project_id, args.sql, args.params) as typeof body;
  } catch (err) {
    return mapSdkError(err, "running SQL");
  }

  const table = formatMarkdownTable(body.rows);
  const lines = [
    `**${body.rows.length} row${body.rows.length !== 1 ? "s" : ""} returned** (schema: ${body.schema})`,
    ``,
    table,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
