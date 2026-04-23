import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const setSecretSchema = {
  project_id: z.string().describe("The project ID"),
  key: z
    .string()
    .describe("Secret key (uppercase alphanumeric + underscores, e.g. 'STRIPE_SECRET_KEY')"),
  value: z
    .string()
    .describe("Secret value (will be injected as process.env in functions)"),
};

export async function handleSetSecret(args: {
  project_id: string;
  key: string;
  value: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().secrets.set(args.project_id, args.key, args.value);
    return {
      content: [
        {
          type: "text",
          text: `## Secret Set\n\nSecret \`${args.key}\` has been set for project \`${args.project_id}\`.\n\nAccess it in your functions via \`process.env.${args.key}\`.`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "setting secret");
  }
}
