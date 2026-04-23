import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const deleteFunctionSchema = {
  project_id: z.string().describe("The project ID"),
  name: z.string().describe("Function name to delete"),
};

export async function handleDeleteFunction(args: {
  project_id: string;
  name: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().functions.delete(args.project_id, args.name);
    return {
      content: [
        {
          type: "text",
          text: `Function \`${args.name}\` deleted from project \`${args.project_id}\`.`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "deleting function");
  }
}
