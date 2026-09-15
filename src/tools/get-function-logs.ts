import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import type { FunctionLogEntry, FunctionLogOriginFilter, FunctionLogsHiddenCounts } from "../../sdk/dist/index.js";

const FUNCTION_LOG_REQUEST_ID_RE = /^(?:req|fnrun|fnatt)_[A-Za-z0-9_-]{4,128}$/;

export const getFunctionLogsSchema = {
  project_id: z.string().describe("The project ID"),
  name: z
    .string()
    .optional()
    .describe(
      "Function name to get logs for. Optional when request_id is given: the search then fans out across every function in the project and each line is prefixed with its function name.",
    ),
  tail: z
    .number()
    .optional()
    .describe("Number of log lines to return (default: 50, max: 1000). Bounds the read before the origin filter."),
  since: z
    .string()
    .optional()
    .describe(
      "Only return logs at or after this ISO 8601 timestamp (e.g. 2026-03-29T14:00:00Z). Invalid timestamps are rejected before the API call.",
    ),
  request_id: z
    .string()
    .regex(FUNCTION_LOG_REQUEST_ID_RE, "Must be a Run402 request/run/attempt id like req_abc123, fnrun_abc123, or fnatt_abc123")
    .optional()
    .describe("Only return logs correlated to this routed request id (the x-run402-request-id response header), function run id, or attempt id, such as req_abc123, fnrun_abc123, or fnatt_abc123."),
  origin: z
    .enum(["app", "platform", "all"])
    .optional()
    .describe(
      "Which lines to return. 'app' = the function's own output only; 'platform' = Lambda runtime lines only (INIT_START, START/END/REPORT RequestId, billed duration); 'all' (default) = both. Every rendered line is tagged [app] or [platform].",
    ),
};

export async function handleGetFunctionLogs(args: {
  project_id: string;
  name?: string;
  tail?: number;
  since?: string;
  request_id?: string;
  origin?: FunctionLogOriginFilter;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (!args.name && !args.request_id) {
    return {
      content: [
        {
          type: "text",
          text: "Pass `name` (one function's logs) or `request_id` (search every function in the project for that request), or both.",
        },
      ],
      isError: true,
    };
  }

  try {
    if (!args.name) {
      const result = await getSdk().functions.logsByRequestId(args.project_id, args.request_id!, {
        tail: args.tail,
        since: args.since,
        origin: args.origin,
      });
      const header = `## Function Logs: request ${result.request_id}`;
      const scanned = result.scanned.length > 0 ? `_Scanned: ${result.scanned.join(", ")}_` : "_Scanned: no functions deployed_";
      const errorLines = result.errors.map((e) => `- ${e.function}: ${e.message}${e.code ? ` (${e.code})` : ""}`);
      const trailer = [
        ...(errorLines.length > 0 ? ["", "**Log reads that failed:**", ...errorLines] : []),
        ...originFooter(result.origin, result.hidden),
      ];

      if (result.entries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: [
                header,
                "",
                scanned,
                "",
                `_No log lines correlated to ${result.request_id}${result.origin === "app" ? " (app output)" : ""}._`,
                ...trailer,
              ].join("\n"),
            },
          ],
        };
      }

      const lines = [
        header,
        "",
        scanned,
        "",
        "```",
        ...result.entries.map((entry) => formatLogLine(entry, entry.function)),
        "```",
        "",
        `_${result.entries.length} log entries_`,
        ...trailer,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    const body = await getSdk().functions.logs(args.project_id, args.name, {
      tail: args.tail,
      since: args.since,
      requestId: args.request_id,
      origin: args.origin,
    });

    const logs = body.logs || [];
    if (logs.length === 0) {
      const hiddenPlatform = body.hidden?.platform ?? 0;
      const reason = hiddenPlatform > 0
        ? `_No app output; ${hiddenPlatform} platform line${hiddenPlatform === 1 ? "" : "s"} (INIT_START/REPORT) hidden. Pass origin: "all" to see them._`
        : "_No logs found. The function may not have been invoked yet._";
      return {
        content: [
          {
            type: "text",
            text: `## Function Logs: ${args.name}\n\n${reason}`,
          },
        ],
      };
    }

    const lines = [
      `## Function Logs: ${args.name}`,
      ``,
      `\`\`\``,
      ...logs.map((entry) => formatLogLine(entry)),
      `\`\`\``,
      ``,
      `_${logs.length} log entries_`,
      ...originFooter(body.origin, body.hidden),
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "fetching function logs");
  }
}

function originFooter(origin: FunctionLogOriginFilter, hidden: FunctionLogsHiddenCounts | undefined): string[] {
  if (origin === "all" || !hidden) return [];
  const dropped = origin === "app" ? hidden.platform : hidden.app;
  if (dropped <= 0) return [];
  const what = origin === "app" ? "platform (INIT_START/REPORT)" : "app";
  return ["", `_${dropped} ${what} line${dropped === 1 ? "" : "s"} hidden by origin: "${origin}"; pass origin: "all" to see them._`];
}

function formatLogLine(log: FunctionLogEntry, functionName?: string): string {
  const metadata = [
    log.request_id ? `request_id=${log.request_id}` : null,
    log.event_id ? `event_id=${log.event_id}` : null,
    log.log_stream_name ? `stream=${log.log_stream_name}` : null,
    log.ingestion_time ? `ingested=${log.ingestion_time}` : null,
  ].filter(Boolean);
  const suffix = metadata.length > 0 ? ` {${metadata.join(" ")}}` : "";
  const fn = functionName ? ` [${functionName}]` : "";
  return `[${log.timestamp}]${fn} [${log.origin}]${suffix} ${log.message}`;
}
