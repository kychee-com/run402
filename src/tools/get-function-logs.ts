import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

const FUNCTION_LOG_REQUEST_ID_RE = /^req_[A-Za-z0-9_-]{4,128}$/;

export const getFunctionLogsSchema = {
  project_id: z.string().describe("The project ID"),
  name: z.string().describe("Function name to get logs for"),
  tail: z
    .number()
    .optional()
    .describe("Number of log lines to return (default: 50, max: 1000)"),
  since: z
    .string()
    .optional()
    .describe(
      "Only return logs at or after this ISO 8601 timestamp (e.g. 2026-03-29T14:00:00Z). Invalid timestamps are rejected before the API call.",
    ),
  request_id: z
    .string()
    .regex(FUNCTION_LOG_REQUEST_ID_RE, "Must be a Run402 request id like req_abc123")
    .optional()
    .describe("Only return logs correlated to this routed/function request id, such as req_abc123."),
};

export async function handleGetFunctionLogs(args: {
  project_id: string;
  name: string;
  tail?: number;
  since?: string;
  request_id?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().functions.logs(args.project_id, args.name, {
      tail: args.tail,
      since: args.since,
      requestId: args.request_id,
    });

    const logs = body.logs || [];
    if (logs.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `## Function Logs: ${args.name}\n\n_No logs found. The function may not have been invoked yet._`,
          },
        ],
      };
    }

    const logLines = logs.map(formatLogLine);

    const lines = [
      `## Function Logs: ${args.name}`,
      ``,
      `\`\`\``,
      ...logLines,
      `\`\`\``,
      ``,
      `_${logs.length} log entries_`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "fetching function logs");
  }
}

function formatLogLine(log: {
  timestamp: string;
  message: string;
  event_id?: string;
  log_stream_name?: string;
  ingestion_time?: string;
  request_id?: string;
}): string {
  const metadata = [
    log.request_id ? `request_id=${log.request_id}` : null,
    log.event_id ? `event_id=${log.event_id}` : null,
    log.log_stream_name ? `stream=${log.log_stream_name}` : null,
    log.ingestion_time ? `ingested=${log.ingestion_time}` : null,
  ].filter(Boolean);
  const suffix = metadata.length > 0 ? ` {${metadata.join(" ")}}` : "";
  return `[${log.timestamp}]${suffix} ${log.message}`;
}
