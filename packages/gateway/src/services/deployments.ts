/**
 * Deployment service — upload static site files to S3, record in DB.
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { S3_BUCKET, S3_REGION } from "../config.js";
import { pool } from "../db/pool.js";
import { getMimeType } from "../utils/mime.js";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

// S3 client (only initialized if S3_BUCKET is set)
const s3 = S3_BUCKET ? new S3Client({ region: S3_REGION }) : null;
const LOCAL_STORAGE_ROOT = process.env.STORAGE_ROOT || "./storage";

// 50 MB max per deployment
const MAX_DEPLOYMENT_SIZE = 50 * 1024 * 1024;

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
  await pool.query(`
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
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_deployments_project
      ON internal.deployments(project_id) WHERE project_id IS NOT NULL
  `);
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
    if (totalSize > MAX_DEPLOYMENT_SIZE) {
      throw new DeploymentError(
        `Deployment exceeds 50 MB limit (${(totalSize / 1024 / 1024).toFixed(1)} MB)`,
        400,
      );
    }

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
    `INSERT INTO internal.deployments (id, name, project_id, target, files_count, total_size, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, req.project, req.project, req.target || null, decoded.length, totalSize, txHash || null],
  );

  const url = `https://${dnsLabel}.sites.run402.com`;

  console.log(`  Deployment created: ${id} (${decoded.length} files, ${totalSize}B) → ${url}`);

  return { deployment_id: id, url };
}

/**
 * Get deployment by ID.
 */
export async function getDeployment(id: string): Promise<DeploymentRecord | null> {
  const result = await pool.query(
    `SELECT id, name, project_id, target, files_count, total_size, tx_hash, created_at
     FROM internal.deployments WHERE id = $1`,
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
 * Custom error with HTTP status code.
 */
export class DeploymentError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}
