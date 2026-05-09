import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import type {
  ExposeManifestValidationInput,
  ExposeManifestValidationResult,
} from "../../sdk/dist/index.js";

const manifestObjectSchema = z.record(z.unknown()).describe(
  "Auth/expose manifest object used by manifest.json, database.expose, and apply_expose.",
);

export const validateManifestSchema = {
  manifest: z
    .union([manifestObjectSchema, z.string()])
    .describe("Auth/expose manifest as a JSON object or JSON string. This is not a deploy manifest."),
  migration_sql: z.string().optional().describe(
    "Optional migration SQL used only as reference context for validation; it is not executed.",
  ),
  project_id: z.string().optional().describe(
    "Optional project id for live-schema validation. Omit for projectless validation.",
  ),
};

export async function handleValidateManifest(args: {
  manifest: ExposeManifestValidationInput;
  migration_sql?: string;
  project_id?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  let result: ExposeManifestValidationResult;
  try {
    result = await getSdk().projects.validateExpose(args.manifest, {
      ...(args.project_id ? { project: args.project_id } : {}),
      ...(args.migration_sql !== undefined ? { migrationSql: args.migration_sql } : {}),
    });
  } catch (err) {
    return mapSdkError(err, "validating expose manifest");
  }

  const lines = [
    "## Expose Manifest Validation",
    "",
    result.hasErrors
      ? "**Result:** validation found blocking errors."
      : "**Result:** no blocking validation errors.",
    "",
    "```json",
    JSON.stringify(result, null, 2),
    "```",
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
