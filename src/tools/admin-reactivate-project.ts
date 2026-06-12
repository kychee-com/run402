import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const adminReactivateProjectSchema = {
  project_id: z
    .string()
    .describe(
      "The project ID to un-archive. Platform-admin only — flips `projects.archived_at` back to NULL. In v1.57 this was narrowed: it does NOT reactivate a grace-state organization. For that, subscribe a tier (`run402 tier set <tier>`) or toggle the organization-level escape hatch via `admin_set_lease_perpetual`.",
    ),
};

export async function handleAdminReactivateProject(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().admin.reactivateProject(args.project_id);
    if (body.note === "not archived") {
      return {
        content: [
          {
            type: "text",
            text: `Project \`${body.project_id}\` was not archived; no change.`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Project \`${body.project_id}\` reactivated (un-archived).`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "reactivating project");
  }
}
