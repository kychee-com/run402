/**
 * Cloudflare Worker — custom domain edge routing for Run402.
 *
 * Reads the Host header, looks up the domain in KV to get a deployment_id,
 * fetches the file from S3, and returns it with appropriate cache headers.
 *
 * SPA fallback: paths without file extensions serve /index.html.
 * HTML responses get the fork badge injected.
 */

export interface Env {
  DOMAINS: KVNamespace;
  S3_BUCKET: string;
  S3_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname.toLowerCase();

    // Look up domain → deployment_id in KV
    const deploymentId = await env.DOMAINS.get(hostname);
    if (!deploymentId) {
      return new Response("<!DOCTYPE html><html><head><title>Not Found</title></head>" +
        "<body><h1>404</h1><p>Domain not configured.</p></body></html>",
        { status: 404, headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } });
    }

    // Determine file path with SPA fallback
    let filePath = url.pathname;
    if (filePath === "/") {
      filePath = "/index.html";
    } else if (!hasExtension(filePath)) {
      filePath = "/index.html";
    }

    const relativePath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
    const s3Key = `sites/${deploymentId}/${relativePath}`;
    const isHtml = filePath.endsWith(".html");

    // Fetch from S3
    const s3Response = await fetchFromS3(env, s3Key);
    if (!s3Response.ok) {
      if (s3Response.status === 404 || s3Response.status === 403) {
        return new Response("<!DOCTYPE html><html><head><title>Not Found</title></head>" +
          "<body><h1>404</h1><p>File not found.</p></body></html>",
          { status: 404, headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } });
      }
      return new Response("Internal Server Error", { status: 502 });
    }

    const contentType = getMimeType(filePath);

    if (isHtml) {
      // Read body, inject fork badge, return with short cache
      let html = await s3Response.text();
      html = injectForkBadge(html, hostname);
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=60",
        },
      });
    }

    // Static assets — immutable caching
    return new Response(s3Response.body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  },
};

// ---------- S3 Fetch with AWS Signature V4 ----------

async function fetchFromS3(env: Env, key: string): Promise<Response> {
  const host = `${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com`;
  const url = `https://${host}/${encodeS3Key(key)}`;

  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, "").slice(0, 8);
  const amzDate = dateStamp + "T" + now.toISOString().replace(/[-:]/g, "").slice(9, 15) + "Z";
  const region = env.S3_REGION;
  const service = "s3";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  // Canonical request
  const canonicalUri = "/" + encodeS3Key(key);
  const canonicalQuerystring = "";
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "GET", canonicalUri, canonicalQuerystring,
    canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD",
  ].join("\n");

  // String to sign
  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign = [
    "AWS4-HMAC-SHA256", amzDate, credentialScope, canonicalRequestHash,
  ].join("\n");

  // Signing key
  const kDate = await hmac("AWS4" + env.AWS_SECRET_ACCESS_KEY, dateStamp);
  const kRegion = await hmacRaw(kDate, region);
  const kService = await hmacRaw(kRegion, service);
  const kSigning = await hmacRaw(kService, "aws4_request");
  const signature = await hmacHex(kSigning, stringToSign);

  const authorization = `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(url, {
    headers: {
      Host: host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      Authorization: authorization,
    },
  });
}

function encodeS3Key(key: string): string {
  return key.split("/").map(s => encodeURIComponent(s)).join("/");
}

// ---------- Crypto helpers ----------

async function sha256Hex(message: string): Promise<string> {
  const data = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return hexEncode(hash);
}

async function hmac(key: string, message: string): Promise<ArrayBuffer> {
  const keyData = new TextEncoder().encode(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

async function hmacRaw(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

async function hmacHex(key: ArrayBuffer, message: string): Promise<string> {
  const result = await hmacRaw(key, message);
  return hexEncode(result);
}

function hexEncode(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Fork badge injection ----------

/**
 * Inject a lightweight fork badge loader into HTML.
 * Unlike the gateway's badge (which queries the DB), this version
 * loads the badge config from the gateway API client-side.
 */
function injectForkBadge(html: string, hostname: string): string {
  const script = `<script>(function(){
var s=document.createElement("script");
s.src="https://api.run402.com/fork-badge.js?host="+encodeURIComponent("${escapeJs(hostname)}");
s.defer=true;
document.head.appendChild(s);
})()</script>`;

  const bodyCloseIdx = html.lastIndexOf("</body>");
  if (bodyCloseIdx >= 0) {
    return html.slice(0, bodyCloseIdx) + script + "\n" + html.slice(bodyCloseIdx);
  }
  return html + script;
}

function escapeJs(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/</g, "\\x3c");
}

// ---------- MIME types ----------

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript", ".mjs": "application/javascript",
  ".json": "application/json", ".xml": "application/xml",
  ".txt": "text/plain", ".csv": "text/csv",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".webp": "image/webp", ".avif": "image/avif",
  ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm",
  ".pdf": "application/pdf", ".zip": "application/zip",
  ".wasm": "application/wasm", ".map": "application/json",
};

function getMimeType(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = filePath.slice(dot).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

function hasExtension(path: string): boolean {
  const lastSlash = path.lastIndexOf("/");
  const basename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  return basename.includes(".");
}
