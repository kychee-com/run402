/**
 * `jobs` namespace — fixed platform-managed job runs.
 * All methods require the project's service key.
 */

import { ProjectNotFound } from "../errors.js";
import type { Client } from "../kernel.js";

export type ManagedJobType = "kysigned.fflonk_prove.v0_17_0";

export type ManagedJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ManagedJobSubmitRequest {
  job_type: ManagedJobType;
  input: {
    "input.json": Record<string, unknown>;
  };
  max_cost_usd_micros: number;
  /**
   * Optional HTTPS URL pushed once when the job reaches a terminal state
   * (completed/failed/cancelled), so you need not poll. Delivery is durable
   * (at-least-once, retried) and unsigned: dedupe on the `Run402-Webhook-Id`
   * header and re-fetch authoritative state with `get()` before acting — the
   * callback is a trigger, not the source of truth.
   */
  callback_url?: string;
}

export interface ManagedJobError {
  code: string;
  message: string;
}

export interface ManagedJobMetadata {
  wall_seconds?: number;
  cost_usd_micros?: number;
  raw_cost_usd_micros?: number;
  absorbed_overage_usd_micros?: number;
  image_digest?: string;
  spot_rate_usd_hr_micros?: number;
  on_demand_rate_usd_hr_micros?: number;
  instance_type?: string;
  az?: string;
  peak_rss_gb?: number;
  interrupt_count?: number;
  attempt_count?: number;
  billing_status?: string;
  [key: string]: unknown;
}

export interface ManagedJobResponse {
  job_id: string;
  job_type: ManagedJobType;
  status: ManagedJobStatus;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  artifacts?: Record<string, string>;
  metadata?: ManagedJobMetadata;
  error?: ManagedJobError;
}

export interface ManagedJobLogEntry {
  timestamp: string;
  message: string;
  log_stream_name: string;
  event_id: string;
  ingestion_time?: string;
}

export interface ManagedJobLogsOptions {
  /** Maximum number of log entries to return. Gateway default is 100. */
  tail?: number;
  /** Only include events at or after this epoch millisecond timestamp. */
  since?: number;
}

export interface ManagedJobLogsResponse {
  logs: ManagedJobLogEntry[];
}

export class Jobs {
  constructor(private readonly client: Client) {}

  /** Submit a fixed platform-managed job run. */
  async submit(projectId: string, request: ManagedJobSubmitRequest): Promise<ManagedJobResponse> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "submitting job");

    return this.client.request<ManagedJobResponse>("/jobs/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${project.service_key}`,
        "Idempotency-Key": createIdempotencyKey(),
      },
      body: request,
      context: "submitting job",
    });
  }

  /** Get a job run by id. */
  async get(projectId: string, jobId: string): Promise<ManagedJobResponse> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "getting job");

    return this.client.request<ManagedJobResponse>(jobRunPath(jobId), {
      headers: { Authorization: `Bearer ${project.service_key}` },
      context: "getting job",
    });
  }

  /** Read job runner logs. */
  async logs(
    projectId: string,
    jobId: string,
    opts: ManagedJobLogsOptions = {},
  ): Promise<ManagedJobLogsResponse> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "getting job logs");

    const query = new URLSearchParams();
    if (opts.tail !== undefined) query.set("tail", String(opts.tail));
    if (opts.since !== undefined) query.set("since", String(opts.since));
    const suffix = query.toString() ? `?${query.toString()}` : "";

    return this.client.request<ManagedJobLogsResponse>(`${jobRunPath(jobId)}/logs${suffix}`, {
      headers: { Authorization: `Bearer ${project.service_key}` },
      context: "getting job logs",
    });
  }

  /** Cancel a queued or running job. */
  async cancel(projectId: string, jobId: string): Promise<ManagedJobResponse> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "cancelling job");

    return this.client.request<ManagedJobResponse>(jobRunPath(jobId), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${project.service_key}` },
      context: "cancelling job",
    });
  }
}

function jobRunPath(jobId: string): string {
  return `/jobs/v1/runs/${encodeURIComponent(jobId)}`;
}

function createIdempotencyKey(): string {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return `job-${crypto.randomUUID()}`;

  const bytes = new Uint8Array(16);
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return `job-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
