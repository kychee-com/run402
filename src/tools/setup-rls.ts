import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const setupRlsSchema = {
  project_id: z.string().describe("The project ID"),
  template: z
    .enum(["user_owns_rows", "public_read", "public_read_write"])
    .describe(
      "RLS template: user_owns_rows (users can only access their own rows), " +
      "public_read (anyone reads, authenticated users write), " +
      "public_read_write (anyone can read and write)",
    ),
  tables: z
    .array(
      z.object({
        table: z.string().describe("Table name"),
        owner_column: z
          .string()
          .optional()
          .describe("Column containing the user ID (required for user_owns_rows template)"),
      }),
    )
    .describe("Tables to apply RLS policies to"),
};

export async function handleSetupRls(args: {
  project_id: string;
  template: string;
  tables: Array<{ table: string; owner_column?: string }>;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/projects/v1/admin/${args.project_id}/rls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
    body: {
      template: args.template,
      tables: args.tables,
    },
  });

  if (!res.ok) return formatApiError(res, "setting up RLS");

  const body = res.body as { status: string; template: string; tables: string[] };

  const lines = [
    `## RLS Applied`,
    ``,
    `Template **${body.template}** applied to: ${body.tables.map((t) => `\`${t}\``).join(", ")}`,
    ``,
    `Row-level security is now active on these tables.`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
