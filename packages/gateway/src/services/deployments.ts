/**
 * Deployment service — upload static site files to S3, record in DB.
 */

import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { S3_BUCKET, S3_REGION } from "../config.js";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { getMimeType } from "../utils/mime.js";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { cacheInvalidateByNames } from "./subdomains.js";

// S3 client (only initialized if S3_BUCKET is set)
const s3 = S3_BUCKET ? new S3Client({ region: S3_REGION }) : null;
const LOCAL_STORAGE_ROOT = process.env.STORAGE_ROOT || "./storage";

export interface DeploymentFile {
  file: string;
  data: string;
  encoding?: "utf-8" | "base64";
}

export interface DeploymentRequest {
  project: string;
  target?: string;
  files: DeploymentFile[];
}

export interface DeploymentResult {
  deployment_id: string;
  url: string;
  subdomain_urls?: string[];
}

export interface DeploymentRecord {
  id: string;
  name: string;
  url: string;
  project_id: string | null;
  status: string;
  created_at: string;
  files_count: number;
  total_size: number;
}

/**
 * Generate a unique deployment ID.
 * Format: dpl_{timestamp}_{random6hex}
 */
function generateDeploymentId(): string {
  const ts = Date.now();
  const rand = randomBytes(3).toString("hex"); // 6 hex chars
  return `dpl_${ts}_${rand}`;
}

/**
 * Convert deployment ID to DNS-safe subdomain.
 * Underscores → hyphens (reversible since IDs never contain hyphens).
 */
function toDnsLabel(id: string): string {
  return id.replace(/_/g, "-");
}

/**
 * Ensure the deployments table exists (idempotent).
 */
export async function initDeploymentsTable(): Promise<void> {
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.deployments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_id TEXT,
      target TEXT,
      files_count INTEGER NOT NULL DEFAULT 0,
      total_size BIGINT NOT NULL DEFAULT 0,
      tx_hash TEXT,
      ref_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));
  await pool.query(sql(`
    CREATE INDEX IF NOT EXISTS idx_deployments_project
      ON internal.deployments(project_id) WHERE project_id IS NOT NULL
  `));
}

/**
 * Create a deployment: upload files to S3, record in DB.
 */
export async function createDeployment(
  req: DeploymentRequest,
  txHash?: string,
): Promise<DeploymentResult> {
  const id = generateDeploymentId();
  const dnsLabel = toDnsLabel(id);

  // Decode and measure all files
  const decoded: Array<{ path: string; buffer: Buffer; mime: string }> = [];
  let totalSize = 0;

  for (const f of req.files) {
    const encoding = f.encoding || "utf-8";
    const buffer = encoding === "base64"
      ? Buffer.from(f.data, "base64")
      : Buffer.from(f.data, "utf-8");

    totalSize += buffer.length;

    decoded.push({
      path: f.file,
      buffer,
      mime: getMimeType(f.file),
    });
  }

  // Upload all files to S3 (or local fallback)
  const s3Prefix = `sites/${id}`;

  for (const file of decoded) {
    if (s3 && S3_BUCKET) {
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${s3Prefix}/${file.path}`,
        Body: file.buffer,
        ContentType: file.mime,
        CacheControl: "public, max-age=31536000, immutable",
      }));
    } else {
      // Local filesystem fallback for dev
      const localPath = join(LOCAL_STORAGE_ROOT, s3Prefix, file.path);
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, file.buffer);
    }
  }

  // Record in DB
  await pool.query(
    sql(`INSERT INTO internal.deployments (id, name, project_id, target, files_count, total_size, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`),
    [id, req.project, req.project, req.target || null, decoded.length, totalSize, txHash || null],
  );

  const url = `https://${dnsLabel}.sites.run402.com`;

  console.log(`  Deployment created: ${id} (${decoded.length} files, ${totalSize}B) → ${url}`);

  // Auto-reassign any subdomains that belong to this project
  const subdomainUrls: string[] = [];
  if (req.project) {
    const subResult = await pool.query(
      sql(`UPDATE internal.subdomains
       SET deployment_id = $1, updated_at = NOW()
       WHERE project_id = $2 AND deployment_id != $1
       RETURNING name`),
      [id, req.project],
    );
    if (subResult.rows.length > 0) {
      const names = subResult.rows.map((r: { name: string }) => r.name);
      cacheInvalidateByNames(names);
      for (const name of names) {
        subdomainUrls.push(`https://${name}.run402.com`);
        console.log(`  Subdomain auto-reassigned: ${name} → ${id}`);
      }
    }
  }

  const result: DeploymentResult = { deployment_id: id, url };
  if (subdomainUrls.length > 0) result.subdomain_urls = subdomainUrls;
  return result;
}

/**
 * Get deployment by ID.
 */
export async function getDeployment(id: string): Promise<DeploymentRecord | null> {
  const result = await pool.query(
    sql(`SELECT id, name, project_id, target, files_count, total_size, tx_hash, created_at
     FROM internal.deployments WHERE id = $1`),
    [id],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const dnsLabel = toDnsLabel(row.id);

  return {
    id: row.id,
    name: row.name,
    url: `https://${dnsLabel}.sites.run402.com`,
    project_id: row.project_id,
    status: "READY",
    created_at: row.created_at,
    files_count: row.files_count,
    total_size: Number(row.total_size),
  };
}

/**
 * Delete all deployments for a project (cleanup on project archive).
 * Best-effort: logs warnings on S3 failures, always cleans up DB.
 */
export async function deleteProjectDeployments(projectId: string): Promise<void> {
  const result = await pool.query(
    sql(`SELECT id FROM internal.deployments WHERE project_id = $1`),
    [projectId],
  );

  for (const row of result.rows) {
    const prefix = `sites/${row.id}/`;
    if (s3 && S3_BUCKET) {
      try {
        // List and batch-delete all objects under this deployment
        let continuationToken: string | undefined;
        do {
          const list = await s3.send(new ListObjectsV2Command({
            Bucket: S3_BUCKET,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }));
          const keys = (list.Contents || []).map(obj => ({ Key: obj.Key! }));
          if (keys.length > 0) {
            await s3.send(new DeleteObjectsCommand({
              Bucket: S3_BUCKET,
              Delete: { Objects: keys },
            }));
          }
          continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
        } while (continuationToken);
      } catch (err) {
        console.error(`  Warning: failed to delete S3 files for deployment ${row.id}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  await pool.query(sql(`DELETE FROM internal.deployments WHERE project_id = $1`), [projectId]);
}

/**
 * Custom error with HTTP status code.
 */
export class DeploymentError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}
