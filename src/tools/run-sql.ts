import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { resolveProjectId } from "../active-project.js";

export const runSqlSchema = {
  project_id: z.string().optional().describe("The project ID to run SQL against (defaults to the active project)"),
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
  project_id?: string;
  sql: string;
  params?: unknown[];
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = await resolveProjectId(args.project_id);
  if (typeof project !== "string") return project;

  let body: {
    status: string;
    schema: string;
    rows: Record<string, unknown>[];
    rowCount: number | null;
  };
  try {
    body = await getSdk().projects.sql(project, args.sql, args.params) as typeof body;
  } catch (err) {
    return mapSdkError(err, "running SQL");
  }

  const { rows, rowCount, schema } = body;

  // The gateway distinguishes statement kinds by `rowCount`: a result set
  // (SELECT / ... RETURNING) populates `rows`; an INSERT/UPDATE/DELETE returns
  // `rows: []` with a numeric affected-row count; DDL returns `rowCount: null`.
  // Surface each kind explicitly — never report a mutation that changed rows
  // as "0 rows returned", which reads to an agent like the statement no-op'd.
  let text: string;
  if (rows.length > 0) {
    text = `**${rows.length} row${rows.length !== 1 ? "s" : ""} returned** (schema: ${schema})\n\n${formatMarkdownTable(rows)}`;
  } else if (typeof rowCount === "number" && rowCount > 0) {
    text = `**${rowCount} row${rowCount !== 1 ? "s" : ""} affected** (schema: ${schema})`;
  } else if (rowCount === 0) {
    // A mutation that matched nothing, or an empty result set — indistinguishable
    // here (both are rows: [], rowCount: 0), so stay neutral.
    text = `**0 rows** (schema: ${schema})`;
  } else {
    // DDL and other statements with no row semantics (rowCount === null).
    text = `**Statement executed** (schema: ${schema})`;
  }

  return { content: [{ type: "text", text }] };
}
