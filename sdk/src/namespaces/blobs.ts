/**
 * `blobs` namespace — direct-to-S3 blob storage.
 *
 * `put` encapsulates the 3-step upload flow (init → PUT parts to S3 →
 * complete). The S3 PUT uses `client.fetch` directly (not the gateway's
 * `request`) so it bypasses gateway auth and path-rewriting. The client's
 * configured fetch still flows through any wrappers (e.g. test mocks).
 */

import type { Client } from "../kernel.js";
import { ApiError, ProjectNotFound } from "../errors.js";
import type {
  BlobLsOptions,
  BlobLsResult,
  BlobPutOptions,
  BlobPutResult,
  BlobPutSource,
  BlobSignOptions,
  BlobSignResult,
} from "./blobs.types.js";

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function guessContentType(key: string): string {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
    json: "application/json",
    txt: "text/plain",
    md: "text/markdown",
    pdf: "application/pdf",
    zip: "application/zip",
    tgz: "application/gzip",
    gz: "application/gzip",
  };
  return map[ext] ?? "application/octet-stream";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // crypto.subtle.digest typings disallow SharedArrayBuffer-backed views;
  // cast through BufferSource to accept the concrete Uint8Array instance.
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface UploadInitResponse {
  upload_id: string;
  mode: "single" | "multipart";
  parts: Array<{ part_number: number; url: string; byte_start: number; byte_end: number }>;
  part_count: number;
}

export class Blobs {
  constructor(private readonly client: Client) {}

  /**
   * Upload a blob via the 3-step direct-to-S3 flow. The bytes are PUT to
   * presigned S3 URLs — they do NOT pass through the gateway, so uploads
   * are not double-billed as API calls and large files stream efficiently.
   *
   * Pass `immutable: true` to produce a content-addressed URL (the server
   * computes no hash — the SDK does it locally and attests via `sha256`).
   *
   * @throws {ProjectNotFound} if `projectId` is not in the provider.
   */
  async put(
    projectId: string,
    key: string,
    source: BlobPutSource,
    opts: BlobPutOptions = {},
  ): Promise<BlobPutResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "uploading blob");

    if ((source.content !== undefined && source.bytes !== undefined) ||
        (source.content === undefined && source.bytes === undefined)) {
      throw new Error("Provide exactly one of `content` or `bytes` in BlobPutSource.");
    }

    const bytes: Uint8Array = source.bytes
      ? source.bytes
      : new TextEncoder().encode(source.content!);
    const sizeBytes = bytes.byteLength;

    if (source.content !== undefined && sizeBytes > 1_048_576) {
      throw new Error("`content` is limited to 1 MB. Use `bytes` for larger uploads.");
    }

    const contentType = opts.contentType ?? guessContentType(key);
    const sha256 = opts.immutable ? await sha256Hex(bytes) : undefined;

    // 1. Init upload — gateway returns presigned S3 URLs for each part.
    const init = await this.client.request<UploadInitResponse>("/storage/v1/uploads", {
      method: "POST",
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${project.anon_key}`,
      },
      body: {
        key,
        size_bytes: sizeBytes,
        content_type: contentType,
        visibility: opts.visibility ?? "public",
        immutable: opts.immutable ?? false,
        sha256,
      },
      context: "initializing upload",
    });

    // 2. PUT each part directly to S3 via the presigned URL.
    const partEtags: Array<{ etag: string }> = new Array(init.part_count);
    for (const part of init.parts) {
      const partBytes = bytes.subarray(part.byte_start, part.byte_end + 1);
      const putRes = await this.client.fetch(part.url, {
        method: "PUT",
        body: partBytes as BodyInit,
      });
      if (!putRes.ok) {
        const errText = await putRes.text().catch(() => "");
        throw new ApiError(
          `Part ${part.part_number} PUT failed (HTTP ${putRes.status} ${putRes.statusText})${errText ? ": " + errText.slice(0, 200) : ""}`,
          putRes.status,
          errText,
          "uploading blob part",
        );
      }
      partEtags[part.part_number - 1] = {
        etag: (putRes.headers.get("etag") ?? "").replace(/^"|"$/g, ""),
      };
    }

    // 3. Complete upload — gateway finalizes (commits multipart, writes DB row).
    const completeBody = init.mode === "multipart"
      ? { parts: partEtags.map((e, i) => ({ part_number: i + 1, etag: `"${e.etag}"` })) }
      : {};
    return this.client.request<BlobPutResult>(
      `/storage/v1/uploads/${init.upload_id}/complete`,
      {
        method: "POST",
        headers: {
          apikey: project.anon_key,
          Authorization: `Bearer ${project.anon_key}`,
        },
        body: completeBody,
        context: "completing upload",
      },
    );
  }

  /**
   * Download a blob. Returns the raw `Response` so callers can stream to
   * disk, pipe to another sink, or buffer with `.bytes()` / `.arrayBuffer()`.
   * This avoids forcing large blobs through a JS buffer.
   *
   * @throws {ProjectNotFound} if `projectId` is not in the provider.
   * @throws {ApiError} on non-2xx (includes the error text from the response body).
   */
  async get(projectId: string, key: string): Promise<Response> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "downloading blob");

    const url = `${this.client.apiBase}/storage/v1/blob/${encodeKey(key)}`;
    const res = await this.client.fetch(url, {
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${project.anon_key}`,
      },
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new ApiError(
        `Downloading blob failed (HTTP ${res.status})`,
        res.status,
        errText,
        "downloading blob",
      );
    }
    return res;
  }

  /** List blobs with optional prefix + pagination. */
  async ls(projectId: string, opts: BlobLsOptions = {}): Promise<BlobLsResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "listing blobs");

    const qs = new URLSearchParams();
    if (opts.prefix) qs.set("prefix", opts.prefix);
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.cursor) qs.set("cursor", opts.cursor);
    const query = qs.toString();
    const path = `/storage/v1/blobs${query ? "?" + query : ""}`;

    return this.client.request<BlobLsResult>(path, {
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${project.anon_key}`,
      },
      context: "listing blobs",
    });
  }

  /** Delete a blob and decrement the project's storage_bytes. */
  async rm(projectId: string, key: string): Promise<void> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "deleting blob");

    await this.client.request<unknown>(`/storage/v1/blob/${encodeKey(key)}`, {
      method: "DELETE",
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${project.anon_key}`,
      },
      context: "deleting blob",
    });
  }

  /** Generate a time-boxed S3 presigned GET URL for a blob. Default TTL 1 hour, max 7 days. */
  async sign(projectId: string, key: string, opts: BlobSignOptions = {}): Promise<BlobSignResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "signing blob URL");

    const body: Record<string, unknown> = {};
    if (opts.ttl_seconds !== undefined) body.ttl_seconds = opts.ttl_seconds;

    return this.client.request<BlobSignResult>(
      `/storage/v1/blob/${encodeKey(key)}/sign`,
      {
        method: "POST",
        headers: {
          apikey: project.anon_key,
          Authorization: `Bearer ${project.anon_key}`,
        },
        body,
        context: "signing blob URL",
      },
    );
  }
}
