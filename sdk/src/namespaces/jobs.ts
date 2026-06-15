/**
 * `jobs` namespace — platform-managed job runs.
 * All methods require the project's service key.
 */

import { ApiError, ProjectNotFound } from "../errors.js";
import type { Client } from "../kernel.js";

export type ManagedJobType = string;

export type ManagedJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ManagedJobSubmitRequest {
  jobType: ManagedJobType;
  input: {
    inputJson: Record<string, unknown>;
  };
  maxCostUsdMicros: number;
  /**
   * Optional HTTPS URL pushed once when the job reaches a terminal state
   * (completed/failed/cancelled), so you need not poll. Delivery is durable
   * (at-least-once, retried) and unsigned: dedupe on the `Run402-Webhook-Id`
   * header and re-fetch authoritative state with `get()` before acting — the
   * callback is a trigger, not the source of truth.
   */
  callbackUrl?: string;
}

export interface ManagedJobSubmitRequestWireCompat {
  job_type: ManagedJobType;
  input: {
    input_json?: Record<string, unknown>;
    "input.json"?: Record<string, unknown>;
  };
  max_cost_usd_micros: number;
  callback_url?: string;
}

type ManagedJobSubmitRequestInput =
  | ManagedJobSubmitRequest
  | ManagedJobSubmitRequestWireCompat;

type ManagedJobSubmitWireRequest = {
  job_type: ManagedJobType;
  input: {
    input_json: Record<string, unknown>;
  };
  max_cost_usd_micros: number;
  callback_url?: string;
};

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

/**
 * A recorded output file from a completed job run.
 *
 * Returned as the values of the `artifacts` map on {@link ManagedJobResponse}
 * (and in the terminal-completion webhook). The legacy `run402://storage/...`
 * ref strings — which were never resolvable — have been retired: `url` is an
 * absolute HTTPS endpoint that streams the raw bytes under the project's
 * service key (the same auth as the rest of `/jobs/v1`). Fetch it with
 * {@link Jobs.downloadArtifact} (which resolves the service key for you) or
 * directly with an `Authorization: Bearer <service_key>` header.
 *
 * `content_type`, `sha256`, and `size_bytes` are absent for jobs created before
 * the artifact-ref change; `url` still serves in that case.
 */
export interface ManagedJobArtifact {
  /** Absolute HTTPS URL that streams the raw artifact bytes (service-key auth). */
  url: string;
  /** MIME type of the artifact bytes (e.g. `application/json`, `text/plain`). */
  content_type?: string;
  /** Lowercase-hex SHA-256 of the bytes. */
  sha256?: string;
  /** Size of the artifact in bytes. */
  size_bytes?: number;
}

export interface ManagedJobResponse {
  job_id: string;
  job_type: ManagedJobType;
  status: ManagedJobStatus;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  /**
   * Recorded outputs for a completed run, keyed by filename. Each value is a
   * {@link ManagedJobArtifact} object (the pre-retirement `run402://` ref
   * strings are gone). Absent until the job reaches a terminal state with
   * recorded artifacts.
   */
  artifacts?: Record<string, ManagedJobArtifact>;
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

export interface ManagedJobPurgeResponse {
  deleted_jobs: number;
  /** Queued/running jobs included in the purge. */
  cancelled_active_jobs: number;
  /** Known EC2 runner instances terminated before records were deleted. */
  terminated_instances: number;
}

export class Jobs {
  constructor(private readonly client: Client) {}

  /** Submit a platform-managed job run for a run402-configured job type. */
  async submit(projectId: string, request: ManagedJobSubmitRequestInput): Promise<ManagedJobResponse> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "submitting job");

    const body = managedJobSubmitRequestToWire(request);
    return this.client.request<ManagedJobResponse>("/jobs/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${project.service_key}`,
        "Idempotency-Key": createIdempotencyKey(),
      },
      body,
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

  /**
   * Download a completed job's artifact by filename. Returns the raw `Response`
   * so callers can stream to disk or buffer with `.bytes()` / `.text()` —
   * this avoids forcing large artifacts through a JS string.
   *
   * Discover the available filenames from the `artifacts` map on {@link get}.
   *
   * @throws {ProjectNotFound} if `projectId` is not in the provider.
   * @throws {ApiError} on non-2xx — notably `404` when the job has not
   *   completed or the filename was not recorded for the run.
   */
  async downloadArtifact(projectId: string, jobId: string, filename: string): Promise<Response> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "downloading job artifact");

    const url = `${this.client.apiBase}${jobRunPath(jobId)}/artifacts/${encodeURIComponent(filename)}`;
    const res = await this.client.fetch(url, {
      headers: { Authorization: `Bearer ${project.service_key}` },
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new ApiError(
        `Downloading job artifact failed (HTTP ${res.status})`,
        res.status,
        errText,
        "downloading job artifact",
      );
    }
    return res;
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

  /** Purge all managed job runs for a project. Active runners are terminated when known. */
  async purge(projectId: string): Promise<ManagedJobPurgeResponse> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "purging jobs");

    return this.client.request<ManagedJobPurgeResponse>("/jobs/v1/runs", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${project.service_key}` },
      context: "purging jobs",
    });
  }
}

function jobRunPath(jobId: string): string {
  return `/jobs/v1/runs/${encodeURIComponent(jobId)}`;
}

function managedJobSubmitRequestToWire(
  request: ManagedJobSubmitRequestInput,
): ManagedJobSubmitWireRequest {
  if ("jobType" in request) {
    return {
      job_type: request.jobType,
      input: { input_json: request.input.inputJson },
      max_cost_usd_micros: request.maxCostUsdMicros,
      ...(request.callbackUrl ? { callback_url: request.callbackUrl } : {}),
    };
  }
  const inputJson = request.input.input_json ?? request.input["input.json"];
  return {
    job_type: request.job_type,
    input: { input_json: inputJson ?? {} },
    max_cost_usd_micros: request.max_cost_usd_micros,
    ...(request.callback_url ? { callback_url: request.callback_url } : {}),
  };
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
