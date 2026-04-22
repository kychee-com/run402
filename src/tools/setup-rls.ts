import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

// Raw shape exported for MCP registration (server.tool() accepts ZodRawShape only).
export const setupRlsSchema = {
  project_id: z.string().describe("The project ID"),
  template: z
    .enum(["user_owns_rows", "public_read_authenticated_write", "public_read_write_UNRESTRICTED"])
    .describe(
      "RLS template. Prefer `user_owns_rows` for anything user-scoped. " +
      "user_owns_rows (users access only their own rows; requires owner_column), " +
      "public_read_authenticated_write (anyone reads; any authenticated user can write ANY row — collaborative tables only), " +
      "public_read_write_UNRESTRICTED (⚠ fully open; anon_key can INSERT/UPDATE/DELETE any row; requires i_understand_this_is_unrestricted: true).",
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
  i_understand_this_is_unrestricted: z
    .boolean()
    .optional()
    .describe(
      "Required to be true when template is public_read_write_UNRESTRICTED. " +
      "Acknowledges that anon_key will have full INSERT/UPDATE/DELETE on the listed tables. " +
      "Ignored for other templates.",
    ),
};

// Refined schema for pre-network validation at the handler boundary.
// Exported for unit tests.
export const setupRlsRefined = z.object(setupRlsSchema).superRefine((data, ctx) => {
  if (data.template === "public_read_write_UNRESTRICTED" && data.i_understand_this_is_unrestricted !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["i_understand_this_is_unrestricted"],
      message:
        "i_understand_this_is_unrestricted must be true when template is public_read_write_UNRESTRICTED",
    });
  }
});

export async function handleSetupRls(args: {
  project_id: string;
  template: string;
  tables: Array<{ table: string; owner_column?: string }>;
  i_understand_this_is_unrestricted?: boolean;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const parsed = setupRlsRefined.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return {
      content: [{ type: "text", text: `Validation error: ${issues}` }],
      isError: true,
    };
  }

  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const body: Record<string, unknown> = {
    template: args.template,
    tables: args.tables,
  };
  if (args.i_understand_this_is_unrestricted !== undefined) {
    body.i_understand_this_is_unrestricted = args.i_understand_this_is_unrestricted;
  }

  const res = await apiRequest(`/projects/v1/admin/${args.project_id}/rls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
    body,
  });

  if (!res.ok) return formatApiError(res, "setting up RLS");

  const resBody = res.body as { status: string; template: string; tables: string[] };

  const lines = [
    `## RLS Applied`,
    ``,
    `Template **${resBody.template}** applied to: ${resBody.tables.map((t) => `\`${t}\``).join(", ")}`,
    ``,
    `Row-level security is now active on these tables.`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
