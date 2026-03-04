/**
 * Subdomain middleware — intercept requests to custom subdomains.
 *
 * For requests to {name}.run402.com (excluding api, www, *.sites, etc.),
 * resolve the subdomain to a deployment and serve the file from S3.
 */

import { Request, Response, NextFunction } from "express";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { S3_BUCKET, S3_REGION } from "../config.js";
import { resolveSubdomain } from "../services/subdomains.js";
import { getMimeType } from "../utils/mime.js";
import { hasName } from "../utils/errors.js";

const s3 = S3_BUCKET ? new S3Client({ region: S3_REGION }) : null;
const LOCAL_STORAGE_ROOT = process.env.STORAGE_ROOT || "./storage";

/** Hosts that should bypass subdomain routing entirely. */
const SKIP_HOSTS = new Set(["api.run402.com", "www.run402.com", "run402.com"]);

/**
 * Early middleware: if the request is for a custom subdomain, serve the
 * deployment's files directly and do NOT call next().
 */
export function subdomainMiddleware(req: Request, res: Response, next: NextFunction): void {
  const host = (req.hostname || "").toLowerCase();

  // Skip non-run402 hosts (local dev, health checks, etc.)
  if (!host.endsWith(".run402.com") && host !== "run402.com") {
    next();
    return;
  }

  // Skip known system hosts
  if (SKIP_HOSTS.has(host)) {
    next();
    return;
  }

  // Skip *.sites.run402.com (deployment subdomains handled by CloudFront)
  if (host.endsWith(".sites.run402.com")) {
    next();
    return;
  }

  // Extract subdomain: "myapp.run402.com" → "myapp"
  const suffix = ".run402.com";
  const subdomain = host.slice(0, -suffix.length);

  // Skip multi-level subdomains (e.g. "a.b.run402.com")
  if (subdomain.includes(".")) {
    next();
    return;
  }

  // Resolve and serve
  handleSubdomainRequest(subdomain, req, res).catch((err) => {
    console.error(`Subdomain middleware error (${subdomain}):`, err);
    if (!res.headersSent) {
      res.status(500).send("Internal server error");
    }
  });
}

async function handleSubdomainRequest(
  subdomain: string,
  req: Request,
  res: Response,
): Promise<void> {
  const deploymentId = await resolveSubdomain(subdomain);

  if (!deploymentId) {
    res.status(404).set("Content-Type", "text/html").send(
      `<!DOCTYPE html><html><head><title>Not Found</title></head>` +
      `<body><h1>404</h1><p>Subdomain <strong>${escapeHtml(subdomain)}</strong> is not configured.</p></body></html>`,
    );
    return;
  }

  // Determine file path with SPA fallback
  let filePath = req.path;
  if (filePath === "/") {
    filePath = "/index.html";
  } else if (!hasExtension(filePath)) {
    // SPA fallback: paths without file extensions serve index.html
    filePath = "/index.html";
  }

  // Remove leading slash for S3 key
  const relativePath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
  const s3Key = `sites/${deploymentId}/${relativePath}`;

  try {
    if (s3 && S3_BUCKET) {
      const obj = await s3.send(new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
      }));
      const contentType = obj.ContentType || getMimeType(filePath);
      const body = await obj.Body!.transformToByteArray();
      res.set("Content-Type", contentType);
      res.set("Cache-Control", "public, max-age=3600");
      res.send(Buffer.from(body));
    } else {
      // Local filesystem fallback for dev
      const localPath = join(LOCAL_STORAGE_ROOT, s3Key);
      if (!existsSync(localPath)) {
        res.status(404).set("Content-Type", "text/html").send(
          `<!DOCTYPE html><html><head><title>Not Found</title></head>` +
          `<body><h1>404</h1><p>File not found.</p></body></html>`,
        );
        return;
      }
      const fileContent = readFileSync(localPath);
      res.set("Content-Type", getMimeType(filePath));
      res.set("Cache-Control", "public, max-age=3600");
      res.send(fileContent);
    }
  } catch (err: unknown) {
    if (hasName(err, "NoSuchKey")) {
      res.status(404).set("Content-Type", "text/html").send(
        `<!DOCTYPE html><html><head><title>Not Found</title></head>` +
        `<body><h1>404</h1><p>File not found.</p></body></html>`,
      );
      return;
    }
    throw err;
  }
}

/** Check if a path has a file extension. */
function hasExtension(path: string): boolean {
  const lastSlash = path.lastIndexOf("/");
  const basename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  return basename.includes(".");
}

/** Minimal HTML escaping. */
function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
