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

/** Render the result column descriptors as a compact "Columns:" line. */
function formatColumns(
  fields: { name: string; type?: string }[] | undefined,
): string | null {
  if (!fields || fields.length === 0) return null;
  return (
    "Columns: " + fields.map((f) => (f.type ? `${f.name} (${f.type})` : f.name)).join(", ")
  );
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
    row_count: number | null;
    fields?: { name: string; type?: string }[];
  };
  try {
    body = await getSdk().projects.sql(project, args.sql, args.params) as typeof body;
  } catch (err) {
    return mapSdkError(err, "running SQL");
  }

  // The wire field is snake_case `row_count` (docs/style.md). This tool
  // previously destructured a nonexistent camelCase `rowCount`, which was
  // always undefined — every mutation rendered as "Statement executed"
  // instead of "N rows affected" (2026-07-19 review finding).
  const { rows, row_count: rowCount, schema, fields } = body;
  const columns = formatColumns(fields);

  // The gateway distinguishes statement kinds by `row_count`: a result set
  // (SELECT / ... RETURNING) populates `rows`; an INSERT/UPDATE/DELETE returns
  // `rows: []` with a numeric affected-row count; DDL returns `row_count: null`.
  // Surface each kind explicitly — never report a mutation that changed rows
  // as "0 rows returned", which reads to an agent like the statement no-op'd.
  // `fields` (present only for result-set queries) carries the column names +
  // types, so an empty SELECT still conveys its shape.
  let text: string;
  if (rows.length > 0) {
    const head = `**${rows.length} row${rows.length !== 1 ? "s" : ""} returned** (schema: ${schema})`;
    text = `${head}${columns ? `\n${columns}` : ""}\n\n${formatMarkdownTable(rows)}`;
  } else if (typeof rowCount === "number" && rowCount > 0) {
    text = `**${rowCount} row${rowCount !== 1 ? "s" : ""} affected** (schema: ${schema})`;
  } else if (rowCount === 0) {
    // An empty result set OR a no-match mutation. When `fields` is present the
    // statement was a SELECT / ... RETURNING, so surface the column shape — an
    // empty SELECT still teaches the agent what it would have returned, instead
    // of a blind "0 rows". Absent fields ⇒ a mutation that matched nothing.
    const head = `**0 rows** (schema: ${schema})`;
    text = columns ? `${head}\n${columns}` : head;
  } else {
    // DDL and other statements with no row semantics (row_count === null).
    text = `**Statement executed** (schema: ${schema})`;
  }

  return { content: [{ type: "text", text }] };
}
