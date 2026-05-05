import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const pinProjectSchema = {
  project_id: z
    .string()
    .describe(
      "The project ID to pin. Admin only — uses the configured allowance wallet for run402 platform admin auth; project owners authenticating with service_key or a non-admin SIWX wallet will receive 403 admin_required.",
    ),
};

export async function handlePinProject(
  args: { project_id: string },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().projects.pin(args.project_id);
    return {
      content: [
        {
          type: "text",
          text: `Project \`${args.project_id}\` pinned successfully.${body.message ? ` ${body.message}` : ""}`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "pinning project");
  }
}
