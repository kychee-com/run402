import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

/**
 * MCP tool `wait_for_cdn_freshness`.
 *
 * Polls the gateway's diagnose endpoint until the URL serves the expected
 * SHA-256, or the timeout elapses. **Mutable URLs only** — for immutable
 * URLs (the `immutableUrl` field returned by `assets_put`) no waiting is
 * needed; they're bound to a SHA at upload time and never previously cached.
 */
export const blobWaitFreshSchema = {
  project_id: z.string().describe("Project ID that owns the URL"),
  url: z.string().describe("Mutable blob URL to poll (e.g. https://app.run402.com/_blob/avatar.png)"),
  sha256: z.string().describe("Expected hex SHA-256 (from a preceding upload)"),
  timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .optional()
    .describe("Max wait in milliseconds (1 000 – 600 000, default 60 000)"),
};

type Args = {
  project_id: string;
  url: string;
  sha256: string;
  timeout_ms?: number;
};

export async function handleBlobWaitFresh(
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await getSdk().assets.waitFresh(args.project_id, {
      url: args.url,
      sha256: args.sha256,
      timeoutMs: args.timeout_ms ?? 60_000,
    });
    const headline = result.fresh
      ? `FRESH: CDN now serving the expected SHA after ${result.attempts} probe(s) over ${result.elapsedMs}ms (vantage ${result.vantage}).`
      : `TIMEOUT: CDN still serving SHA ${result.observedSha256 ?? "<none>"} after ${result.attempts} probe(s) over ${result.elapsedMs}ms. The URL may eventually catch up — re-try, or use the immutableUrl.`;
    return {
      content: [
        {
          type: "text",
          text:
            `${headline}\n\n` +
            "```json\n" +
            JSON.stringify(result, null, 2) +
            "\n```",
        },
      ],
      isError: result.fresh ? undefined : true,
    };
  } catch (err) {
    return mapSdkError(err, "waiting for CDN freshness");
  }
}
