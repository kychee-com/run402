import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import type {
  FunctionRunHandle,
  FunctionRunRetryPolicy,
  FunctionRunStatus,
} from "../../sdk/dist/index.js";

const functionRunStatusSchema = z.enum([
  "scheduled",
  "queued",
  "running",
  "retrying",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

const retrySchema = z.object({
  preset: z.literal("standard").optional().describe("Retry preset. Currently `standard`."),
  max_attempts: z.number().int().positive().optional().describe("Maximum attempts including the first attempt."),
  min_delay_seconds: z.number().nonnegative().optional().describe("Minimum retry delay in seconds."),
  max_delay_seconds: z.number().nonnegative().optional().describe("Maximum retry delay in seconds."),
}).optional();

const waitFields = {
  wait: z.boolean().optional().describe("Wait until the run becomes terminal before returning."),
  timeout_ms: z.number().int().positive().optional().describe("Maximum wait time in milliseconds."),
  poll_interval_ms: z.number().int().nonnegative().optional().describe("Polling interval in milliseconds."),
};

export const createFunctionRunSchema = {
  project_id: z.string().describe("The project ID"),
  name: z.string().describe("Function name to run"),
  event_type: z.string().describe("Application event type delivered to the function run handler"),
  payload: z.record(z.unknown()).optional().describe("JSON object payload delivered to the handler"),
  idempotency_key: z.string().describe("Required idempotency key. Reuse it when retrying the same logical work item."),
  delay: z.string().optional().describe("Delay before first attempt, such as `10m`, `1h`, or `3d`. Mutually exclusive with run_at."),
  delay_seconds: z.number().nonnegative().optional().describe("Delay before first attempt in seconds. Mutually exclusive with delay and run_at."),
  run_at: z.string().optional().describe("Absolute ISO-8601 first-attempt time. Mutually exclusive with delay/delay_seconds."),
  expires_at: z.string().optional().describe("Absolute ISO-8601 expiry time."),
  expires_after: z.string().optional().describe("Relative expiry duration, such as `1d`."),
  retry: retrySchema,
  ...waitFields,
};

export const listFunctionRunsSchema = {
  project_id: z.string().describe("The project ID"),
  name: z.string().describe("Function name"),
  status: functionRunStatusSchema.optional().describe("Filter by run status"),
  event_type: z.string().optional().describe("Filter by event type"),
  since: z.string().optional().describe("Only include runs created/updated at or after this ISO timestamp or epoch ms."),
  until: z.string().optional().describe("Only include runs created/updated before this ISO timestamp or epoch ms."),
  limit: z.number().int().positive().max(100).optional().describe("Maximum runs to return (max 100)."),
  cursor: z.string().optional().describe("Pagination cursor returned by a prior list call."),
};

export const getFunctionRunSchema = {
  project_id: z.string().describe("The project ID"),
  run_id: z.string().describe("Function run id, fnrun_..."),
};

export const getFunctionRunLogsSchema = {
  project_id: z.string().describe("The project ID"),
  run_id: z.string().describe("Function run id, fnrun_..."),
  tail: z.number().int().positive().max(1000).optional().describe("Number of log entries to return (default 50, max 1000)."),
  since: z.string().optional().describe("Only include logs at or after this ISO timestamp or epoch ms."),
};

export const cancelFunctionRunSchema = {
  project_id: z.string().describe("The project ID"),
  run_id: z.string().describe("Function run id, fnrun_..."),
};

export const redriveFunctionRunSchema = {
  project_id: z.string().describe("The project ID"),
  run_id: z.string().describe("Function run id, fnrun_..."),
  retry: retrySchema,
  ...waitFields,
};

export async function handleCreateFunctionRun(args: {
  project_id: string;
  name: string;
  event_type: string;
  payload?: Record<string, unknown>;
  idempotency_key: string;
  delay?: string;
  delay_seconds?: number;
  run_at?: string;
  expires_at?: string;
  expires_after?: string;
  retry?: SnakeRetry;
  wait?: boolean;
  timeout_ms?: number;
  poll_interval_ms?: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const sdk = getSdk();
    const created = await sdk.functions.runs.create(args.project_id, args.name, {
      eventType: args.event_type,
      payload: args.payload,
      idempotencyKey: args.idempotency_key,
      delay: args.delay,
      delaySeconds: args.delay_seconds,
      runAt: args.run_at,
      expiresAt: args.expires_at,
      expiresAfter: args.expires_after,
      retry: toRetryPolicy(args.retry),
    });
    const run = args.wait
      ? await sdk.functions.runs.wait(args.project_id, created.run_id, waitOptions(args))
      : created;
    return { content: [{ type: "text", text: renderRun("Function Run Created", run) }] };
  } catch (err) {
    return mapSdkError(err, "creating function run");
  }
}

export async function handleListFunctionRuns(args: {
  project_id: string;
  name: string;
  status?: FunctionRunStatus;
  event_type?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await getSdk().functions.runs.list(args.project_id, args.name, {
      status: args.status,
      eventType: args.event_type,
      since: args.since,
      until: args.until,
      limit: args.limit,
      cursor: args.cursor,
    });
    const runs = result.runs ?? [];
    if (runs.length === 0) {
      return { content: [{ type: "text", text: `## Function Runs: ${args.name}\n\n_No runs found._` }] };
    }
    const lines = [
      `## Function Runs: ${args.name}`,
      ``,
      `| run_id | status | event_type | scheduled/run_at | attempts |`,
      `|--------|--------|------------|------------------|----------|`,
      ...runs.map((run) => `| \`${run.run_id}\` | ${run.status}${run.terminal ? " (terminal)" : ""} | \`${run.event_type}\` | ${runTime(run)} | ${attemptSummary(run)} |`),
    ];
    if (result.next_cursor) lines.push(``, `next_cursor: \`${result.next_cursor}\``);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing function runs");
  }
}

export async function handleGetFunctionRun(args: {
  project_id: string;
  run_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const run = await getSdk().functions.runs.get(args.project_id, args.run_id);
    return { content: [{ type: "text", text: renderRun("Function Run", run) }] };
  } catch (err) {
    return mapSdkError(err, "fetching function run");
  }
}

export async function handleGetFunctionRunLogs(args: {
  project_id: string;
  run_id: string;
  tail?: number;
  since?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().functions.runs.logs(args.project_id, args.run_id, {
      tail: args.tail,
      since: args.since,
    });
    const logs = body.logs ?? [];
    if (logs.length === 0) {
      return { content: [{ type: "text", text: `## Function Run Logs: ${args.run_id}\n\n_No logs found._` }] };
    }
    const lines = [
      `## Function Run Logs: ${args.run_id}`,
      ``,
      `\`\`\``,
      ...logs.map(formatLogLine),
      `\`\`\``,
      ``,
      `_${logs.length} log entries_`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "fetching function run logs");
  }
}

export async function handleCancelFunctionRun(args: {
  project_id: string;
  run_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const run = await getSdk().functions.runs.cancel(args.project_id, args.run_id);
    return { content: [{ type: "text", text: renderRun("Function Run Cancelled", run) }] };
  } catch (err) {
    return mapSdkError(err, "cancelling function run");
  }
}

export async function handleRedriveFunctionRun(args: {
  project_id: string;
  run_id: string;
  retry?: SnakeRetry;
  wait?: boolean;
  timeout_ms?: number;
  poll_interval_ms?: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const sdk = getSdk();
    const redriven = await sdk.functions.runs.redrive(args.project_id, args.run_id, {
      retry: toRetryPolicy(args.retry),
    });
    const run = args.wait
      ? await sdk.functions.runs.wait(args.project_id, redriven.run_id, waitOptions(args))
      : redriven;
    return { content: [{ type: "text", text: renderRun("Function Run Redriven", run) }] };
  } catch (err) {
    return mapSdkError(err, "redriving function run");
  }
}

interface SnakeRetry {
  preset?: "standard";
  max_attempts?: number;
  min_delay_seconds?: number;
  max_delay_seconds?: number;
}

function toRetryPolicy(retry: SnakeRetry | undefined): FunctionRunRetryPolicy | undefined {
  if (!retry) return undefined;
  return {
    preset: retry.preset ?? "standard",
    maxAttempts: retry.max_attempts,
    minDelaySeconds: retry.min_delay_seconds,
    maxDelaySeconds: retry.max_delay_seconds,
  };
}

function waitOptions(args: {
  timeout_ms?: number;
  poll_interval_ms?: number;
}) {
  return {
    timeoutMs: args.timeout_ms,
    intervalMs: args.poll_interval_ms,
  };
}

function renderRun(title: string, run: FunctionRunHandle): string {
  const lines = [
    `## ${title}`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| run_id | \`${run.run_id}\` |`,
    `| status | ${run.status}${run.terminal ? " (terminal)" : ""} |`,
    `| function | \`${run.function_name ?? "unknown"}\` |`,
    `| event_type | \`${run.event_type ?? "unknown"}\` |`,
    `| scheduled/run_at | ${runTime(run)} |`,
    `| attempts | ${attemptSummary(run)} |`,
  ];
  if (run.last_error) {
    lines.push(`| last_error | \`${run.last_error.code ?? "ERROR"}\`: ${run.last_error.message ?? ""} |`);
  }
  lines.push(``, `\`\`\`json`, JSON.stringify(run, null, 2), `\`\``);
  return lines.join("\n");
}

function runTime(run: FunctionRunHandle): string {
  const record = run as unknown as Record<string, unknown>;
  const raw = record.run_at ?? record.scheduled_at;
  return typeof raw === "string" ? `\`${raw}\`` : "now";
}

function attemptSummary(run: FunctionRunHandle): string {
  const attempts = (run as unknown as Record<string, unknown>).attempts;
  if (typeof attempts === "number") return String(attempts);
  if (attempts && typeof attempts === "object") {
    const rec = attempts as Record<string, unknown>;
    const current = rec.current ?? "?";
    const max = rec.max ?? "?";
    const total = rec.total ?? current;
    return `${current}/${max} (${total} total)`;
  }
  return "unknown";
}

function formatLogLine(log: {
  timestamp?: string;
  message?: string;
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
  return `[${log.timestamp ?? "unknown"}]${suffix} ${log.message ?? ""}`;
}
