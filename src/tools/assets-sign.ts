import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const blobSignSchema = {
  project_id: z.string().describe("Project ID"),
  key: z.string().describe("Blob key to sign a GET URL for"),
  ttl_seconds: z.number().int().min(60).max(604800).optional().describe("URL lifetime in seconds (60 – 604 800, default 3600)"),
};

type Args = { project_id: string; key: string; ttl_seconds?: number };

export async function handleBlobSign(args: Args): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().assets.sign(args.project_id, args.key, {
      ttl_seconds: args.ttl_seconds,
    });
    return {
      content: [{
        type: "text",
        text: `Signed URL for \`${args.key}\` (expires in ${body.expires_in} seconds, at ${body.expires_at}):\n\n${body.signed_url}`,
      }],
    };
  } catch (err) {
    return mapSdkError(err, "signing blob URL");
  }
}
