import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import {
  buildDeployResolveSummary,
  normalizeDeployResolveRequest,
} from "../../sdk/dist/index.js";

/**
 * MCP `deploy_diagnose_url` tool — read-only public URL diagnostics for the
 * current live deploy release. This wraps SDK `r.deploy.resolve(...)`; it is
 * not a fetch proxy, cache purge, or internal CAS URL inspector.
 */

export const deployDiagnoseUrlSchema = {
  project_id: z
    .string()
    .describe("Project ID used for local apikey lookup. It is not sent as a query parameter."),
  url: z
    .string()
    .optional()
    .describe("Absolute HTTP(S) public URL to diagnose. Mutually exclusive with host/path."),
  host: z
    .string()
    .optional()
    .describe("Lower-level hostname form without scheme, path, query, or fragment."),
  path: z
    .string()
    .optional()
    .describe("Lower-level public URL path. Must start with '/' when supplied."),
  method: z
    .string()
    .optional()
    .describe("HTTP method to diagnose. Defaults to gateway behavior when omitted."),
};

export async function handleDeployDiagnoseUrl(args: {
  project_id: string;
  url?: string;
  host?: string;
  path?: string;
  method?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const input = args.url !== undefined
    ? {
        project: args.project_id,
        url: args.url,
        ...(args.method !== undefined ? { method: args.method } : {}),
        ...(args.host !== undefined ? { host: args.host as never } : {}),
        ...(args.path !== undefined ? { path: args.path as never } : {}),
      }
    : {
        project: args.project_id,
        ...(args.host !== undefined ? { host: args.host } : {}),
        ...(args.path !== undefined ? { path: args.path } : {}),
        ...(args.method !== undefined ? { method: args.method } : {}),
      };

  let request;
  try {
    request = normalizeDeployResolveRequest(input as never);
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error diagnosing deploy URL: ${(err as Error)?.message ?? String(err)}`,
        },
      ],
      isError: true,
    };
  }

  try {
    const resolution = await getSdk().deploy.resolve(input as never);
    const summary = buildDeployResolveSummary(resolution, request);
    const envelope = {
      status: "ok",
      would_serve: summary.would_serve,
      diagnostic_status: summary.diagnostic_status,
      match: summary.match,
      summary: summary.summary,
      request,
      warnings: summary.warnings,
      resolution,
      next_steps: summary.next_steps,
    };
    return {
      content: [
        { type: "text", text: formatResolveEnvelope(envelope) },
        { type: "text", text: jsonSection("Deploy URL Diagnostic", envelope) },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "diagnosing deploy URL");
  }
}

function formatResolveEnvelope(envelope: {
  would_serve: boolean;
  diagnostic_status: number;
  match: string;
  summary: string;
  request: { host: string; path: string; method?: string; ignored?: Record<string, string | undefined> };
  warnings: Array<{ code: string; message: string }>;
  next_steps: Array<{ code: string; message: string }>;
}): string {
  const lines = [
    "## Deploy URL Diagnostic",
    "",
    "| Field | Value |",
    "|-------|-------|",
    `| would_serve | ${envelope.would_serve ? "true" : "false"} |`,
    `| diagnostic_status | ${envelope.diagnostic_status} |`,
    `| match | \`${envelope.match}\` |`,
    `| host | \`${envelope.request.host}\` |`,
    `| path | \`${envelope.request.path}\` |`,
    `| method | ${envelope.request.method ? `\`${envelope.request.method}\`` : "gateway default"} |`,
    "",
    envelope.summary,
  ];
  if (envelope.warnings.length > 0) {
    lines.push("", "### Warnings");
    for (const warning of envelope.warnings) {
      lines.push(`- \`${warning.code}\`: ${warning.message}`);
    }
  }
  if (envelope.next_steps.length > 0) {
    lines.push("", "### Next Steps");
    for (const step of envelope.next_steps) {
      lines.push(`- \`${step.code}\`: ${step.message}`);
    }
  }
  return lines.join("\n");
}

function jsonSection(label: string, value: unknown): string {
  return [`### Raw ${label}`, "", "```json", JSON.stringify(value, null, 2), "```"].join("\n");
}
