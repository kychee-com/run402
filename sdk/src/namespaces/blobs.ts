/**
 * `blobs` namespace — direct-to-S3 blob storage.
 *
 * `put` encapsulates the 3-step upload flow (init → PUT parts to S3 →
 * complete). The S3 PUT uses `client.fetch` directly (not the gateway's
 * `request`) so it bypasses gateway auth and path-rewriting. The client's
 * configured fetch still flows through any wrappers (e.g. test mocks).
 */

import type { Client } from "../kernel.js";
import { ApiError, LocalError, ProjectNotFound } from "../errors.js";
import type {
  BlobCacheKind,
  BlobCdnEnvelope,
  BlobDiagnoseEnvelope,
  BlobLsOptions,
  BlobLsResult,
  BlobPutOptions,
  BlobPutResult,
  BlobPutSource,
  BlobSignOptions,
  BlobSignResult,
  BlobWaitFreshOptions,
  BlobWaitFreshResult,
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

/**
 * Gateway upload-completion response shape (legacy snake_case fields plus
 * any new agent-DX fields the gateway emits). Used internally by `put` to
 * widen into the AssetRef return type the SDK exposes.
 */
interface UploadCompleteResponse {
  key: string;
  size_bytes: number;
  sha256: string | null;
  visibility: "public" | "private";
  content_type: string | null;
  immutable_suffix: string | null;
  etag?: string;
  url: string | null;
  immutable_url: string | null;
  /** v1.45+ agent-DX URLs from the gateway. Always on the auto-subdomain
   *  (`pr-<public_id>.run402.com`) which is guaranteed to work through the
   *  v1.33 CDN path. May be null on private uploads or older gateway
   *  versions that don't emit them. */
  cdn_url?: string | null;
  cdn_immutable_url?: string | null;
  /** Optional: future gateway versions emit a `cdn` envelope on completion
   *  with the CloudFront invalidation ID + status for mutable overwrites
   *  (and `ready: true` for immutable uploads). When absent (current
   *  gateway), the SDK fills in safe defaults from local information. */
  cdn?: Partial<BlobCdnEnvelope>;
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert hex (e.g. `"abcd…"`) to base64 in environments that have either
 * Buffer (Node) or `btoa` (browsers). The helper is here because Browser SDK
 * builds may run without `Buffer`.
 */
function hexToBase64(hex: string): string {
  const len = hex.length;
  const bytes = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  // Prefer Buffer when available (faster on Node).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as unknown as { Buffer?: any; btoa?: (s: string) => string };
  if (g.Buffer) return g.Buffer.from(bytes).toString("base64");
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return g.btoa ? g.btoa(s) : "";
}

/**
 * Widen the gateway's snake_case completion response into the AssetRef
 * shape (which adds camelCase aliases + locally-derived integrity fields
 * for any URL the consumer is about to embed in code). For non-immutable
 * uploads where the SHA is null, the integrity fields are null and the
 * agent guidance steers them to use `--immutable` before linking.
 */
function buildAssetRef(
  resp: UploadCompleteResponse,
  contentType: string,
): BlobPutResult {
  const sha = resp.sha256;
  const immutable = !!resp.immutable_url;
  const cacheKind: BlobCacheKind =
    resp.visibility === "private"
      ? "private"
      : immutable
      ? "immutable"
      : "mutable";
  const etag = sha ? `"sha256-${sha}"` : null;
  const sri = sha ? `sha256-${hexToBase64(sha)}` : null;
  const contentDigest = sha ? `sha-256=:${hexToBase64(sha)}:` : null;

  // v1.45 agent-DX URLs — guaranteed CDN-reachable on the auto-subdomain.
  // Older gateway versions don't emit them; null in that case (callers fall
  // back to the preferred-host `url` / `immutableUrl`).
  const cdnUrl = resp.cdn_immutable_url ?? null;
  const cdnMutableUrl = resp.cdn_url ?? null;

  // The cdn envelope: prefer what the gateway returns; fall back to
  // best-effort defaults so older gateway versions don't break the SDK
  // surface. immutable URLs are always-ready by definition.
  const cdnFromGw = resp.cdn ?? {};
  const cdn: BlobCdnEnvelope = {
    version: cdnFromGw.version ?? "blob-gateway-v2",
    invalidationId: cdnFromGw.invalidationId ?? null,
    invalidationStatus: cdnFromGw.invalidationStatus ?? null,
    ready: cdnFromGw.ready ?? immutable,
    hint:
      cdnFromGw.hint ??
      (immutable
        ? "Use cdnUrl + scriptTag()/linkTag()/imgTag() — paste-and-go."
        : "For mutable URLs, propagation is asynchronous. Prefer cdnUrl (immutable, content-hashed) for generated HTML/CSS/JS, or call wait_for_cdn_freshness."),
  };

  // Emitter helpers. Throw with an actionable hint when the SHA is null
  // (non-immutable upload) — the agent should re-upload with `immutable:
  // true` to get content-hashed URLs that pair with SRI.
  function requireImmutable(name: string): { url: string; sri: string } {
    if (!cdnUrl || !sri) {
      throw new LocalError(
        `${name}() requires an immutable upload (pass { immutable: true } to blobs.put). ` +
          `Without immutable, there is no SHA to bind for SRI and the URL would change on re-upload.`,
        "rendering blob tag",
      );
    }
    return { url: cdnUrl, sri };
  }

  return {
    key: resp.key,
    size_bytes: resp.size_bytes,
    sha256: sha,
    visibility: resp.visibility,
    url: resp.url,
    immutable_url: resp.immutable_url,
    size: resp.size_bytes,
    contentSha256: sha,
    contentType,
    immutableUrl: resp.immutable_url,
    cdnUrl,
    cdnMutableUrl,
    etag,
    sri,
    contentDigest,
    cacheKind,
    cdn,

    scriptTag(opts) {
      // Default `defer: true` — modern best practice. Defer prevents
      // render-blocking when placed in <head> and is a no-op when placed
      // at the end of <body> (the script runs after DOMContentLoaded
      // either way). Pass `{ defer: false }` to opt out for the rare
      // case requiring synchronous execution. `async` and `defer` are
      // mutually exclusive; passing async overrides defer.
      const { url, sri } = requireImmutable("scriptTag");
      const attrs: string[] = [`src="${escapeHtmlAttr(url)}"`];
      if (opts?.type === "module") attrs.push(`type="module"`);
      const wantsAsync = opts?.async === true;
      const wantsDefer = opts?.defer ?? !wantsAsync;
      if (wantsAsync) attrs.push("async");
      else if (wantsDefer) attrs.push("defer");
      attrs.push(`integrity="${escapeHtmlAttr(sri)}"`);
      attrs.push("crossorigin");
      return `<script ${attrs.join(" ")}></script>`;
    },

    linkTag(opts) {
      // Always emit crossorigin — required for SRI to actually be
      // enforced. Without crossorigin the browser silently ignores the
      // integrity attribute (HTML spec). This applies to rel="preload"
      // too: matching crossorigin on the preload + the eventual fetch is
      // what lets the browser dedupe instead of double-fetching.
      const { url, sri } = requireImmutable("linkTag");
      const rel = opts?.rel ?? "stylesheet";
      const attrs: string[] = [`rel="${escapeHtmlAttr(rel)}"`];
      attrs.push(`href="${escapeHtmlAttr(url)}"`);
      if (opts?.as) attrs.push(`as="${escapeHtmlAttr(opts.as)}"`);
      attrs.push(`integrity="${escapeHtmlAttr(sri)}"`);
      attrs.push("crossorigin");
      return `<link ${attrs.join(" ")}>`;
    },

    imgTag(alt) {
      // Defaults: loading="lazy" + decoding="async" — modern best
      // practice. Lazy is harmless for above-fold images (browsers
      // handle the heuristic) and a flat win for the much more common
      // below-fold case. Async decoding moves the decode off the main
      // thread. Both are baseline-supported in all major browsers.
      // <img> doesn't accept SRI per HTML5; the URL is content-hashed
      // so it's still stable across re-deploys. Agents who need
      // byte-level integrity for images should verify Content-Digest
      // server-side.
      const { url } = requireImmutable("imgTag");
      const a = alt ?? "";
      return `<img src="${escapeHtmlAttr(url)}" alt="${escapeHtmlAttr(a)}" loading="lazy" decoding="async">`;
    },
  };
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

    // Normalize the polymorphic source shape (GH-126). Bare strings and
    // Uint8Arrays are accepted as a shorthand for `{ content }` / `{ bytes }`
    // so callers don't need to know about the wrapper object — every other
    // ContentSource-shaped surface in the SDK accepts the bare form.
    let normalized: { content?: string; bytes?: Uint8Array };
    if (typeof source === "string") {
      normalized = { content: source };
    } else if (source instanceof Uint8Array) {
      normalized = { bytes: source };
    } else {
      normalized = source as { content?: string; bytes?: Uint8Array };
    }

    if ((normalized.content !== undefined && normalized.bytes !== undefined) ||
        (normalized.content === undefined && normalized.bytes === undefined)) {
      throw new LocalError(
        "Provide exactly one of `content` or `bytes` in BlobPutSource.",
        "uploading blob",
      );
    }

    const bytes: Uint8Array = normalized.bytes
      ? normalized.bytes
      : new TextEncoder().encode(normalized.content!);
    const sizeBytes = bytes.byteLength;

    if (normalized.content !== undefined && sizeBytes > 1_048_576) {
      throw new LocalError(
        "`content` is limited to 1 MB. Use `bytes` for larger uploads.",
        "uploading blob",
      );
    }

    const contentType = opts.contentType ?? guessContentType(key);
    // v1.45 default: `immutable: true`. The agent-DX surface (cdnUrl, sri,
    // scriptTag/linkTag/imgTag) only works for content-addressed uploads,
    // so the default reaches for the best path. Pass `{ immutable: false }`
    // explicitly when you specifically want a non-content-hashed URL
    // (e.g. very large file where you want to skip the SHA pass).
    const immutable = opts.immutable ?? true;
    const sha256 = immutable ? await sha256Hex(bytes) : undefined;

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
        immutable,
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
    const completion = await this.client.request<UploadCompleteResponse>(
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

    // Widen the gateway response into the v1.45 AssetRef return type. Older
    // gateway versions don't emit the `cdn` envelope; `buildAssetRef` fills
    // safe defaults derived from the SHA + visibility so the SDK surface is
    // stable across gateway versions.
    return buildAssetRef(completion, contentType);
  }

  /**
   * Diagnose a public blob URL. Returns a JSON envelope describing the live
   * CDN state (expected vs observed SHA, cache headers, recent invalidation
   * status, vantage). The gateway probes the URL once from us-east-1 with
   * `Range: bytes=0-0` and returns within 5 s even if the inner probe is
   * slow.
   *
   * **Vantage caveat:** the result reflects ONE CloudFront PoP at the time
   * of the call. Other PoPs may serve different cached states. The
   * `probeMayHaveWarmedCache: true` field reminds the agent that the probe
   * itself populates the cache, so a subsequent read may differ.
   *
   * The URL must belong to the requesting project — cross-project URLs are
   * rejected by the gateway with `403`. SSRF is enforced gateway-side: only
   * `*.run402.com` and the project's active custom domains are accepted.
   *
   * @example
   *   const diag = await client.blobs.diagnoseUrl("prj_abc", "https://app.run402.com/_blob/avatar.png");
   *   if (diag.observedSha256 !== diag.expectedSha256) console.log(diag.hint);
   */
  async diagnoseUrl(projectId: string, url: string): Promise<BlobDiagnoseEnvelope> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "diagnosing blob URL");

    const path = `/storage/v1/blobs/diagnose?url=${encodeURIComponent(url)}`;
    return this.client.request<BlobDiagnoseEnvelope>(path, {
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${project.anon_key}`,
      },
      context: "diagnosing blob URL",
    });
  }

  /**
   * Poll the CDN until a mutable URL serves the expected SHA-256, or the
   * timeout elapses. **For mutable URLs only** — for immutable URLs (the
   * `immutableUrl` returned by `put`) no waiting is needed; they're bound
   * at upload time and never previously cached.
   *
   * Default `timeoutMs` is 60_000 (60 s). The helper polls the gateway's
   * diagnose endpoint with exponential backoff bounded by 1 s; each poll
   * may itself warm the cache for the probed PoP, so subsequent reads from
   * other PoPs may still be stale until invalidation propagation completes.
   *
   * @example
   *   await client.blobs.waitFresh("prj_abc", {
   *     url: result.url,           // the mutable URL from blobs.put
   *     sha256: result.contentSha256,
   *     timeoutMs: 30_000,
   *   });
   */
  async waitFresh(
    projectId: string,
    opts: BlobWaitFreshOptions,
  ): Promise<BlobWaitFreshResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "waiting for CDN freshness");

    const expected = opts.sha256.toLowerCase();
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const start = Date.now();

    let attempts = 0;
    let observed: string | null = null;
    let delay = 100;
    while (Date.now() - start < timeoutMs) {
      attempts++;
      try {
        const envelope = await this.diagnoseUrl(projectId, opts.url);
        observed = envelope.observedSha256;
        if (observed && observed.toLowerCase() === expected) {
          return {
            fresh: true,
            observedSha256: observed,
            attempts,
            elapsedMs: Date.now() - start,
            vantage: "gateway-us-east-1",
          };
        }
      } catch {
        // Swallow & retry — `diagnoseUrl` can fail on transient gateway
        // hiccups (e.g. ALB cycling). The next poll re-attempts.
      }
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(delay, remaining)));
      delay = Math.min(delay * 2, 1000);
    }
    return {
      fresh: false,
      observedSha256: observed,
      attempts,
      elapsedMs: Date.now() - start,
      vantage: "gateway-us-east-1",
    };
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
