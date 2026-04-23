import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import type { RlsTemplate } from "../../sdk/dist/namespaces/projects.types.js";

// Raw shape exported for MCP registration (server.tool() accepts ZodRawShape only).
export const setupRlsSchema = {
  project_id: z.string().describe("The project ID"),
  template: z
    .enum(["user_owns_rows", "public_read_authenticated_write", "public_read_write_UNRESTRICTED"])
    .describe(
      "⚠ DEPRECATED — use `apply_expose` instead. Sunset: 2026-05-23. " +
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

  try {
    const resBody = await getSdk().projects.setupRls(args.project_id, {
      template: args.template as RlsTemplate,
      tables: args.tables,
      i_understand_this_is_unrestricted: args.i_understand_this_is_unrestricted,
    });

    const lines = [
      `## RLS Applied`,
      ``,
      `Template **${resBody.template}** applied to: ${resBody.tables.map((t) => `\`${t}\``).join(", ")}`,
      ``,
      `Row-level security is now active on these tables.`,
      ``,
      `⚠ **Deprecated** — this endpoint is sunset on 2026-05-23. Migrate to \`apply_expose\` for future RLS changes. See https://run402.com/llms-cli.txt for the manifest format.`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "setting up RLS");
  }
}
