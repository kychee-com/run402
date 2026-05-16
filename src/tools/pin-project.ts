import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const pinProjectSchema = {
  project_id: z
    .string()
    .describe(
      "The project ID to pin. If the project exists in local credentials, the SDK uses its service key; otherwise it uses the configured allowance wallet for run402 platform admin auth.",
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
          text: [
            `Project \`${args.project_id}\` pinned successfully.`,
            typeof body.pinned === "boolean" ? `pinned=${body.pinned}` : null,
            typeof body.was_pinned === "boolean" ? `was_pinned=${body.was_pinned}` : null,
            body.message ?? null,
          ].filter(Boolean).join(" "),
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "pinning project");
  }
}
