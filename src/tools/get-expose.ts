import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const getExposeSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleGetExpose(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  let body: {
    status?: string;
    project_id?: string;
    source?: "applied" | "introspected";
    manifest?: {
      version: string;
      tables: Array<Record<string, unknown>>;
      views: Array<Record<string, unknown>>;
      rpcs: Array<Record<string, unknown>>;
    };
    version?: string;
    tables?: Array<Record<string, unknown>>;
    views?: Array<Record<string, unknown>>;
    rpcs?: Array<Record<string, unknown>>;
  };
  try {
    body = await getSdk().projects.getExpose(args.project_id) as typeof body;
  } catch (err) {
    return mapSdkError(err, "fetching expose manifest");
  }

  const source = body.source ?? "applied";
  const manifest = body.manifest ?? {
    version: body.version ?? "1",
    tables: body.tables ?? [],
    views: body.views ?? [],
    rpcs: body.rpcs ?? [],
  };

  const sourceNote =
    source === "applied"
      ? "from the last-applied manifest recorded in `internal.project_manifest`"
      : "reconstructed by introspecting live DB state (no manifest has ever been applied)";

  const lines = [
    `## Expose Manifest (source: ${source})`,
    ``,
    `_${sourceNote}_`,
    ``,
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
