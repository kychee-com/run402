import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const getFunctionLogsSchema = {
  project_id: z.string().describe("The project ID"),
  name: z.string().describe("Function name to get logs for"),
  tail: z
    .number()
    .optional()
    .describe("Number of log lines to return (default: 50, max: 200)"),
};

export async function handleGetFunctionLogs(args: {
  project_id: string;
  name: string;
  tail?: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const tail = args.tail || 50;
  const res = await apiRequest(
    `/projects/v1/admin/${args.project_id}/functions/${encodeURIComponent(args.name)}/logs?tail=${tail}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${project.service_key}`,
      },
    },
  );

  if (!res.ok) return formatApiError(res, "fetching function logs");

  const body = res.body as { logs: Array<{ timestamp: string; message: string }> };
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

  const logLines = logs.map(
    (log) => `[${log.timestamp}] ${log.message}`,
  );

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
}
