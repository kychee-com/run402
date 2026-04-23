import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const deleteSecretSchema = {
  project_id: z.string().describe("The project ID"),
  key: z.string().describe("Secret key to delete"),
};

export async function handleDeleteSecret(args: {
  project_id: string;
  key: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().secrets.delete(args.project_id, args.key);
    return {
      content: [
        {
          type: "text",
          text: `Secret \`${args.key}\` deleted from project \`${args.project_id}\`.`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "deleting secret");
  }
}
