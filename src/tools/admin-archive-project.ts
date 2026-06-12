import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const adminArchiveProjectSchema = {
  project_id: z
    .string()
    .describe(
      "The project ID to archive. Platform-admin only — sets `projects.archived_at = NOW()` and takes only this project down. Sibling projects on the same organization keep serving.",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "Free-text moderation reason recorded in the audit log (recommended).",
    ),
};

export async function handleAdminArchiveProject(args: {
  project_id: string;
  reason?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const opts = args.reason !== undefined ? { reason: args.reason } : {};
    const body = await getSdk().admin.archiveProject(args.project_id, opts);
    if (body.note === "already archived") {
      return {
        content: [
          {
            type: "text",
            text: `Project \`${body.project_id}\` is already archived; no change.`,
          },
        ],
      };
    }
    const reasonNote = body.reason ? ` Reason: ${body.reason}.` : "";
    return {
      content: [
        {
          type: "text",
          text: `Project \`${body.project_id}\` archived at ${body.archived_at}.${reasonNote}`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "archiving project");
  }
}
