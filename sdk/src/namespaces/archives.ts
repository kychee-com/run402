import type { Client } from "../kernel.js";
import { ApiError, LocalError, NetworkError, NotAuthorizedError, PaymentRequired, Unauthorized } from "../errors.js";
import type {
  ProjectArchiveCreateOptions,
  ProjectArchiveDownload,
  ProjectArchiveDto,
  ProjectArchiveExportOptions,
  ProjectArchiveExportResult,
  ProjectArchiveProgressEvent,
  ProjectArchiveWaitOptions,
} from "./archives.types.js";

const DEFAULT_SCOPE = "portable-runtime-v1";
const DEFAULT_AUTH = "stubs";
const DEFAULT_CONSISTENCY = "pause-writes";
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export class Archives {
  constructor(private readonly client: Client) {}

  async create(projectId: string, opts: ProjectArchiveCreateOptions = {}): Promise<ProjectArchiveDto> {
    assertProjectId(projectId, "creating project archive");
    const body: Record<string, unknown> = {
      scope: opts.scope ?? DEFAULT_SCOPE,
      auth: opts.auth ?? DEFAULT_AUTH,
      consistency: opts.consistency ?? DEFAULT_CONSISTENCY,
    };
    const headers = opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : undefined;
    return this.client.request<ProjectArchiveDto>(archiveCollectionPath(projectId), {
      method: "POST",
      body,
      ...(headers ? { headers } : {}),
      authMeta: {
        method: "archives.create",
        capability: "project.archives.export",
        target: { project_id: projectId },
      },
      context: "creating project archive",
    });
  }

  async get(projectId: string, archiveId: string): Promise<ProjectArchiveDto> {
    assertProjectId(projectId, "getting project archive");
    assertArchiveId(archiveId, "getting project archive");
    return this.client.request<ProjectArchiveDto>(archivePath(projectId, archiveId), {
      authMeta: {
        method: "archives.get",
        capability: "project.archives.export",
        target: { project_id: projectId },
      },
      context: "getting project archive",
    });
  }

  async wait(projectId: string, archiveId: string, opts: ProjectArchiveWaitOptions = {}): Promise<ProjectArchiveDto> {
    assertProjectId(projectId, "waiting for project archive");
    assertArchiveId(archiveId, "waiting for project archive");
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100) {
      throw new LocalError("archives.wait pollIntervalMs must be an integer >= 100", "waiting for project archive");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new LocalError("archives.wait timeoutMs must be a positive integer", "waiting for project archive");
    }

    const started = Date.now();
    for (;;) {
      const archive = await this.get(projectId, archiveId);
      await opts.onProgress?.(progressEvent(projectId, archive, "wait", "archive_export_status", "Archive export status updated."));
      if (archive.status === "ready") return archive;
      if (archive.status === "failed" || archive.status === "expired") return archive;
      if (Date.now() - started >= timeoutMs) {
        throw new LocalError(
          `Timed out waiting for archive ${archiveId}`,
          "waiting for project archive",
          { code: "ARCHIVE_WAIT_TIMEOUT", details: { archive_id: archiveId, timeout_ms: timeoutMs } },
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  async download(projectId: string, archiveId: string): Promise<ProjectArchiveDownload> {
    assertProjectId(projectId, "downloading project archive");
    assertArchiveId(archiveId, "downloading project archive");
    const archive = await this.get(projectId, archiveId);
    if (archive.status !== "ready") {
      throw new LocalError(
        `Archive ${archiveId} is ${archive.status}, not ready for download`,
        "downloading project archive",
        { code: archive.status === "expired" ? "ARCHIVE_EXPIRED" : "ARCHIVE_NOT_READY", details: { archive_id: archiveId, status: archive.status } },
      );
    }

    const path = `${archivePath(projectId, archiveId)}/download`;
    const auth = await this.client.credentials.getAuth(path, {
      method: "archives.download",
      capability: "project.archives.export",
      target: { project_id: projectId },
    });
    const headers: Record<string, string> = auth ? { ...auth } : {};
    let res: Response;
    try {
      res = await this.client.fetch(`${this.client.apiBase}${path}`, { headers });
    } catch (err) {
      throw new NetworkError(`Network error while downloading project archive: ${(err as Error).message}`, err, "downloading project archive");
    }

    if (!res.ok) {
      await throwDownloadError(res);
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      archive,
      bytes,
      contentType: res.headers.get("content-type") ?? archive.content_type ?? "application/x-tar",
      filename: contentDispositionFilename(res.headers.get("content-disposition")) ?? `${archiveId}.r402ar`,
    };
  }

  async export(projectId: string, opts: ProjectArchiveExportOptions = {}): Promise<ProjectArchiveExportResult> {
    const created = await this.create(projectId, opts);
    await opts.onProgress?.(progressEvent(projectId, created, "create", "archive_export_created", "Archive export operation created."));
    const archive = created.status === "ready"
      ? created
      : await this.wait(projectId, created.archive_id, opts);
    if (archive.status !== "ready") {
      throw new LocalError(
        `Archive export ended with status ${archive.status}`,
        "exporting project archive",
        { code: archive.status === "expired" ? "ARCHIVE_EXPIRED" : "ARCHIVE_EXPORT_FAILED", details: { archive_id: archive.archive_id, status: archive.status, error: archive.error } },
      );
    }
    const download = await this.download(projectId, archive.archive_id);
    await opts.onProgress?.(progressEvent(projectId, archive, "download", "archive_export_downloaded", "Archive bytes downloaded."));
    return { ...download, created };
  }
}

function archiveCollectionPath(projectId: string): string {
  return `/projects/v1/${encodeURIComponent(projectId)}/archives`;
}

function archivePath(projectId: string, archiveId: string): string {
  return `${archiveCollectionPath(projectId)}/${encodeURIComponent(archiveId)}`;
}

function assertProjectId(value: string, context: string): void {
  if (!value || typeof value !== "string") {
    throw new LocalError("archive helper requires a projectId", context);
  }
}

function assertArchiveId(value: string, context: string): void {
  if (!value || typeof value !== "string") {
    throw new LocalError("archive helper requires an archiveId", context);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function progressEvent(
  projectId: string,
  archive: ProjectArchiveDto,
  stage: ProjectArchiveProgressEvent["stage"],
  event: string,
  message: string,
): ProjectArchiveProgressEvent {
  const complete = archive.status === "ready" || archive.status === "failed" || archive.status === "expired";
  return {
    event,
    stage,
    resource_type: "project_archive",
    resource_id: archive.archive_id,
    project_id: projectId,
    status: archive.status,
    completed_units: complete ? 1 : 0,
    total_units: 1,
    code: archive.status === "failed" ? archiveCode(archive.error) : null,
    message,
    next_action: archive.next_action,
    retryable: archive.status === "running",
    context: {
      byte_count: archive.byte_count,
      sha256: archive.sha256,
      expires_at: archive.expires_at,
    },
  };
}

function archiveCode(error: unknown): string | null {
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const code = (error as Record<string, unknown>).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

async function throwDownloadError(res: Response): Promise<never> {
  const context = "downloading project archive";
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("application/json")
    ? await res.json().catch(() => null)
    : await res.text().catch(() => "");
  const message = displayMessage(body, "Archive download failed");
  if (res.status === 402) throw new PaymentRequired(`${message} while ${context}`, res.status, body, context);
  if (res.status === 403 && envelopeCode(body) === "NOT_AUTHORIZED") {
    throw new NotAuthorizedError(`${message} while ${context} (HTTP ${res.status})`, res.status, body, context);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Unauthorized(`${message} while ${context} (HTTP ${res.status})`, res.status, body, context);
  }
  throw new ApiError(`${message} while ${context} (HTTP ${res.status})`, res.status, body, context);
}

function displayMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.message.length > 0) return obj.message;
    if (typeof obj.error === "string" && obj.error.length > 0) return obj.error;
  }
  return fallback;
}

function envelopeCode(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const code = (body as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

function contentDispositionFilename(value: string | null): string | null {
  if (!value) return null;
  const match = /filename="([^"]+)"/i.exec(value) ?? /filename=([^;]+)/i.exec(value);
  return match?.[1]?.trim() || null;
}
