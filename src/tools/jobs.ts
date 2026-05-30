import { z } from "zod";

import { mapSdkError } from "../errors.js";
import { getSdk } from "../sdk.js";

const managedJobSubmitRequestSchema = z
  .object({
    job_type: z
      .literal("kysigned.fflonk_prove.v0_17_0")
      .describe("Fixed platform-managed job type to run"),
    input: z
      .object({
        "input.json": z
          .record(z.unknown())
          .describe("JSON object passed to the managed job runner"),
      })
      .strict()
      .describe("Input files for the managed job"),
    max_cost_usd_micros: z
      .number()
      .int()
      .nonnegative()
      .describe("Hard customer charge ceiling in micro-USD"),
    callback_url: z
      .string()
      .url()
      .optional()
      .describe(
        "Optional HTTPS URL pushed once on terminal state (completed/failed/cancelled), so you need not poll. Durable at-least-once + unsigned: dedupe on the Run402-Webhook-Id header and re-fetch with get_managed_job before acting.",
      ),
  })
  .strict();

export const jobsSubmitSchema = {
  project_id: z.string().describe("The project ID"),
  request: managedJobSubmitRequestSchema.describe("Gateway-shaped managed job submit request"),
};

export const jobsGetSchema = {
  project_id: z.string().describe("The project ID"),
  job_id: z.string().describe("Managed job run ID"),
};

export const jobsLogsSchema = {
  project_id: z.string().describe("The project ID"),
  job_id: z.string().describe("Managed job run ID"),
  tail: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Maximum number of log entries to return"),
  since: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Only include logs at or after this epoch millisecond timestamp"),
};

export const jobsCancelSchema = {
  project_id: z.string().describe("The project ID"),
  job_id: z.string().describe("Managed job run ID"),
};

export async function handleJobsSubmit(args: {
  project_id: string;
  request: {
    job_type: "kysigned.fflonk_prove.v0_17_0";
    input: { "input.json": Record<string, unknown> };
    max_cost_usd_micros: number;
    callback_url?: string;
  };
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await getSdk().jobs.submit(args.project_id, args.request);
    return jsonResult("Managed Job Submitted", result);
  } catch (err) {
    return mapSdkError(err, "submitting job");
  }
}

export async function handleJobsGet(args: {
  project_id: string;
  job_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await getSdk().jobs.get(args.project_id, args.job_id);
    return jsonResult("Managed Job", result);
  } catch (err) {
    return mapSdkError(err, "getting job");
  }
}

export async function handleJobsLogs(args: {
  project_id: string;
  job_id: string;
  tail?: number;
  since?: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await getSdk().jobs.logs(args.project_id, args.job_id, {
      tail: args.tail,
      since: args.since,
    });
    return jsonResult("Managed Job Logs", result);
  } catch (err) {
    return mapSdkError(err, "getting job logs");
  }
}

export async function handleJobsCancel(args: {
  project_id: string;
  job_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await getSdk().jobs.cancel(args.project_id, args.job_id);
    return jsonResult("Managed Job Cancelled", result);
  } catch (err) {
    return mapSdkError(err, "cancelling job");
  }
}

function jsonResult(
  title: string,
  body: unknown,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  return {
    content: [
      {
        type: "text",
        text: `## ${title}\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``,
      },
    ],
  };
}
