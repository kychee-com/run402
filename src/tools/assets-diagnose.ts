import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

/**
 * MCP tool `diagnose_public_url`.
 *
 * Returns the gateway's diagnose envelope for a public blob URL: expected
 * vs observed SHA, CloudFront cache state, recent invalidation status,
 * vantage. The probe is single-region (us-east-1); the response self-
 * documents this via `vantage` and `probeMayHaveWarmedCache: true`.
 *
 * Cross-project URLs return 403 (the gateway enforces project ownership);
 * non-`*.run402.com` URLs return 400 SSRF-guard error unless the URL is on
 * one of the requesting project's active custom domains.
 */
export const blobDiagnoseSchema = {
  project_id: z.string().describe("Project ID that owns the URL"),
  url: z.string().describe("Full blob URL (e.g. https://app.run402.com/_blob/avatar.png)"),
};

type Args = { project_id: string; url: string };

export async function handleBlobDiagnose(
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const env = await getSdk().assets.diagnoseUrl(args.project_id, args.url);
    const matched =
      env.observedSha256 != null && env.observedSha256 === env.expectedSha256;
    const summary = matched
      ? `OK: CDN serving the current SHA (probed once from ${env.vantage}; not a global view).`
      : `DIVERGENT: expected ${env.expectedSha256 ?? "<unknown>"} vs observed ${env.observedSha256 ?? "<no x-run402-content-sha256>"} (${env.vantage}).`;
    return {
      content: [
        {
          type: "text",
          text:
            `${summary}\n\nHint: ${env.hint}\n\n` +
            "```json\n" +
            JSON.stringify(toToolDiagnoseEnvelope(env), null, 2) +
            "\n```",
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "diagnosing public blob URL");
  }
}

function toToolDiagnoseEnvelope(env: Awaited<ReturnType<ReturnType<typeof getSdk>["assets"]["diagnoseUrl"]>>): unknown {
  return {
    project_id: env.projectId,
    key: env.key,
    expected_sha256: env.expectedSha256,
    observed_sha256: env.observedSha256,
    vantage: env.vantage,
    probe_method: env.probeMethod,
    accept_encoding: env.acceptEncoding,
    observed_at: env.observedAt,
    probe_may_have_warmed_cache: env.probeMayHaveWarmedCache,
    canonical_url: env.canonicalUrl,
    path_kind: env.pathKind,
    cache: {
      x_cache: env.cache.xCache,
      age_seconds: env.cache.ageSeconds,
      cache_kind: env.cache.cacheKind,
    },
    invalidation: env.invalidation,
    hint: env.hint,
  };
}
