/**
 * Publish service — snapshot a project's live state into an immutable App Version.
 *
 * Uses pg_dump for schema export (pre-data + post-data split).
 * Stores bundle artifact in S3, metadata in internal.app_versions.
 * Published versions can be forked by other agents via POST /fork/v1/:tier.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { S3_BUCKET, S3_REGION } from "../config.js";
import { TIERS } from "@run402/shared";
import type { TierName } from "@run402/shared";
import { resolvePgBinary } from "../utils/pg-binaries.js";
import { fnv1a32 } from "../utils/hash.js";
import { getDeploymentUrl, getSubdomainUrl } from "../utils/public-urls.js";

const execFileAsync = promisify(execFile);

const s3 = S3_BUCKET ? new S3Client({ region: S3_REGION }) : null;
const LOCAL_STORAGE_ROOT = process.env.STORAGE_ROOT || "./storage";

/**
 * Delete a persisted bundle by URI. Logs and swallows errors — orphaned objects
 * are harmless in both S3 and local-dev storage.
 */
async function deleteBundle(bundleUri: string): Promise<void> {
  if (bundleUri.startsWith("local://")) {
    const localPath = join(LOCAL_STORAGE_ROOT, bundleUri.slice("local://".length));
    try {
      unlinkSync(localPath);
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
      if (code !== "ENOENT") console.warn(`  Failed to delete local bundle ${localPath}:`, err);
    }
    return;
  }

  if (!bundleUri.startsWith("s3://") || !s3 || !S3_BUCKET) return;

  const key = bundleUri.replace(`s3://${S3_BUCKET}/`, "");
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  } catch (err) {
    console.warn(`  Failed to delete old bundle ${key}:`, err);
  }
}

// Unsupported object types — publish rejects projects that use these
const UNSUPPORTED_OBJECT_QUERIES = [
  {
    label: "views",
    sql: `SELECT table_name FROM information_schema.views WHERE table_schema = $1 AND table_name NOT LIKE 'pg_%'`,
  },
  {
    label: "materialized views",
    sql: `SELECT matviewname AS name FROM pg_matviews WHERE schemaname = $1`,
  },
  {
    label: "triggers",
    sql: `SELECT DISTINCT trigger_name AS name FROM information_schema.triggers WHERE trigger_schema = $1`,
  },
  {
    label: "custom functions",
    sql: `SELECT routine_name AS name FROM information_schema.routines WHERE routine_schema = $1 AND routine_type = 'FUNCTION'`,
  },
  {
    label: "custom types",
    sql: `SELECT typname AS name FROM pg_type t
          JOIN pg_namespace n ON t.typnamespace = n.oid
          WHERE n.nspname = $1
            AND t.typtype IN ('e', 'd')
            AND t.typname NOT LIKE 'pg_%'`,
    // Note: excludes composite types ('c') since Postgres auto-creates one per table
  },
];

export class PublishError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}

export interface PublishOptions {
  visibility?: "private" | "unlisted" | "public";
  fork_allowed?: boolean;
  description?: string;
  tags?: string[];
  include_seed?: { tables: string[] };
  required_secrets?: Array<{ key: string; description?: string }>;
  required_actions?: Array<{ action: string; description?: string }>;
  bootstrap_variables?: Array<{ name: string; type?: string; required?: boolean; default?: unknown; description?: string }>;
}

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/;
const MAX_TAGS = 10;

/**
 * Validate tags. Returns error message or null.
 */
export function validateTags(tags: string[]): string | null {
  if (!Array.isArray(tags)) return "'tags' must be an array";
  if (tags.length > MAX_TAGS) return `Max ${MAX_TAGS} tags allowed`;
  const seen = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== "string") return "Each tag must be a string";
    if (tag.length < 2) return `Tag '${tag}' is too short (min 2 chars)`;
    if (!TAG_RE.test(tag)) return `Tag '${tag}' must be lowercase alphanumeric + hyphens, 2-30 chars`;
    if (seen.has(tag)) return `Duplicate tag: '${tag}'`;
    seen.add(tag);
  }
  return null;
}

export interface AppVersionInfo {
  id: string;
  project_id: string;
  version: number;
  name: string;
  description: string | null;
  visibility: string;
  fork_allowed: boolean;
  min_tier: TierName;
  derived_min_tier: TierName;
  status: string;
  table_count: number;
  function_count: number;
  site_file_count: number;
  site_total_bytes: number;
  required_secrets: Array<{ key: string; description?: string }>;
  required_actions: Array<{ action: string; description?: string }>;
  tags: string[];
  live_url: string | null;
  bootstrap_variables: unknown[] | null;
  created_at: string;
  compatibility_warnings: string[];
}

/**
 * Ensure the app_versions tables exist (idempotent).
 */
export async function initAppVersionsTables(): Promise<void> {
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.app_versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      visibility TEXT NOT NULL DEFAULT 'private',
      fork_allowed BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'published',
      min_tier TEXT NOT NULL DEFAULT 'prototype',
      derived_min_tier TEXT NOT NULL DEFAULT 'prototype',
      format_version INTEGER NOT NULL DEFAULT 1,
      bundle_uri TEXT NOT NULL,
      bundle_sha256 TEXT NOT NULL,
      publisher_wallet TEXT,
      required_secrets JSONB NOT NULL DEFAULT '[]',
      required_actions JSONB NOT NULL DEFAULT '[]',
      capabilities JSONB NOT NULL DEFAULT '[]',
      table_count INTEGER NOT NULL DEFAULT 0,
      function_count INTEGER NOT NULL DEFAULT 0,
      site_file_count INTEGER NOT NULL DEFAULT 0,
      site_total_bytes BIGINT NOT NULL DEFAULT 0,
      seed_row_count INTEGER NOT NULL DEFAULT 0,
      site_deployment_id TEXT,
      bootstrap_variables JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(project_id, version)
    )
  `));
  // Add bootstrap_variables column if table predates this feature
  await pool.query(sql(`
    ALTER TABLE internal.app_versions ADD COLUMN IF NOT EXISTS bootstrap_variables JSONB
  `));
  await pool.query(sql(`
    CREATE INDEX IF NOT EXISTS idx_app_versions_project
      ON internal.app_versions(project_id)
  `));
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.app_version_functions (
      version_id TEXT NOT NULL REFERENCES internal.app_versions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      runtime TEXT NOT NULL DEFAULT 'node22',
      timeout_seconds INTEGER NOT NULL DEFAULT 10,
      memory_mb INTEGER NOT NULL DEFAULT 128,
      deps TEXT[] DEFAULT '{}',
      code_hash TEXT NOT NULL,
      PRIMARY KEY (version_id, name)
    )
  `));
}

/**
 * Generate a version ID.
 */
function generateVersionId(): string {
  const ts = Date.now();
  const rand = randomBytes(3).toString("hex");
  return `ver_${ts}_${rand}`;
}

/**
 * Compute derived minimum tier from artifact stats.
 */
function computeDerivedMinTier(functionCount: number, siteTotalBytes: number): TierName {
  if (functionCount > TIERS.hobby.maxFunctions) return "team";
  if (functionCount > TIERS.prototype.maxFunctions) return "hobby";
  if (siteTotalBytes > TIERS.hobby.storageMb * 1024 * 1024) return "team";
  if (siteTotalBytes > TIERS.prototype.storageMb * 1024 * 1024) return "hobby";
  return "prototype";
}

/**
 * Run pg_dump for a schema and return the SQL output.
 */
async function pgDumpSchema(
  schemaSlot: string,
  section: "pre-data" | "post-data" | "data",
  tables?: string[],
): Promise<string> {
  const dbHost = process.env.DB_HOST || "localhost";
  const dbPort = process.env.DB_PORT || "5432";
  const dbName = process.env.DB_NAME || "agentdb";
  const dbUser = process.env.DB_USER || "postgres";
  const dbPassword = process.env.DB_PASSWORD || "postgres";

  const args = [
    `--host=${dbHost}`,
    `--port=${dbPort}`,
    `--username=${dbUser}`,
    `--dbname=${dbName}`,
    `--schema=${schemaSlot}`,
    `--no-owner`,
    `--no-comments`,
    `--no-password`,
  ];

  if (section === "data") {
    args.push("--data-only");
    if (tables) {
      for (const t of tables) {
        args.push(`--table=${schemaSlot}.${t}`);
      }
    }
  } else {
    args.push("--schema-only");
    args.push(`--section=${section}`);
    // Keep privileges — GRANTs reference standard PostgREST roles
    // (anon, authenticated, service_role) which exist in all run402 instances.
    // The fork service also applies base grants as a safety net.
  }

  const env = { ...process.env, PGPASSWORD: dbPassword };

  try {
    const { stdout } = await execFileAsync(resolvePgBinary("pg_dump"), args, {
      env,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    // pg_dump from newer client builds may emit session-level SET commands
    // unsupported by older local Postgres servers (for example PG17 client
    // against PG16 server). They are safe to drop from the portable bundle.
    return stdout.replace(/^SET transaction_timeout = 0;\s*$/gm, "");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PublishError(`pg_dump failed: ${msg}`, 500);
  }
}

/**
 * Replace schema name with placeholder for portability.
 */
function canonicalizeSchema(sql: string, schemaSlot: string): string {
  // Simple global replacement of schema name with placeholder.
  // Remove CREATE SCHEMA and GRANT USAGE ON SCHEMA lines (target schema already has these).
  return sql
    .replace(new RegExp(schemaSlot, "g"), "__SCHEMA__")
    .replace(/^CREATE SCHEMA __SCHEMA__;\s*$/gm, "")
    .replace(/^GRANT USAGE ON SCHEMA __SCHEMA__ TO .*;\s*$/gm, "");
}

/**
 * Restore schema placeholder to a target schema name.
 */
export function decanonicalizeSchema(sql: string, targetSchema: string): string {
  return sql.replace(/__SCHEMA__/g, targetSchema);
}

/**
 * Publish an app version — snapshot current project state.
 */
export async function publishAppVersion(
  projectId: string,
  projectName: string,
  schemaSlot: string,
  publisherWallet: string | undefined,
  options: PublishOptions,
): Promise<AppVersionInfo> {
  const warnings: string[] = [];

  // Validate tags
  const tags = options.tags || [];
  if (tags.length > 0) {
    const tagError = validateTags(tags);
    if (tagError) throw new PublishError(tagError, 400);
  }

  // Acquire advisory lock to prevent concurrent publish/deploy.
  // Hash the full projectId — reading the first 4 bytes collides across all
  // projects (every id starts with "prj_") and serializes the whole platform.
  const lockId = fnv1a32(projectId);
  await pool.query(sql(`SELECT pg_advisory_lock($1)`), [lockId]);

  try {
    // Check for unsupported objects
    for (const check of UNSUPPORTED_OBJECT_QUERIES) {
      const result = await pool.query(sql(check.sql), [schemaSlot]);
      if (result.rows.length > 0) {
        const names = result.rows.map((r) => r.name || r.table_name).join(", ");
        throw new PublishError(
          `Project uses unsupported ${check.label}: ${names}. Remove them before publishing.`,
          400,
        );
      }
    }

    // Check all functions have source
    const functionsResult = await pool.query(
      sql(`SELECT name, source, runtime, timeout_seconds, memory_mb, deps, code_hash
       FROM internal.functions WHERE project_id = $1 ORDER BY name`),
      [projectId],
    );
    for (const fn of functionsResult.rows) {
      if (!fn.source) {
        throw new PublishError(
          `Function '${fn.name}' has no stored source. Redeploy it before publishing.`,
          400,
        );
      }
    }

    // Get table count
    const tablesResult = await pool.query(
      sql(`SELECT count(*)::int AS cnt FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'`),
      [schemaSlot],
    );
    const tableCount = tablesResult.rows[0].cnt;

    // Get site deployment info
    const siteResult = await pool.query(
      sql(`SELECT id, files_count, total_size FROM internal.deployments
       WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`),
      [projectId],
    );
    const siteDeploymentId = siteResult.rows[0]?.id || null;
    const siteFileCount = siteResult.rows[0]?.files_count || 0;
    const siteTotalBytes = Number(siteResult.rows[0]?.total_size || 0);

    // Run pg_dump for pre-data and post-data
    const preSchemaRaw = await pgDumpSchema(schemaSlot, "pre-data");
    const postSchemaRaw = await pgDumpSchema(schemaSlot, "post-data");
    const preSchemaSql = canonicalizeSchema(preSchemaRaw, schemaSlot);
    const postSchemaSql = canonicalizeSchema(postSchemaRaw, schemaSlot);

    // Optional seed data
    let seedSql: string | null = null;
    let seedRowCount = 0;
    if (options.include_seed && options.include_seed.tables.length > 0) {
      const seedRaw = await pgDumpSchema(schemaSlot, "data", options.include_seed.tables);
      seedSql = canonicalizeSchema(seedRaw, schemaSlot);
      // Rough row count from INSERT statements
      seedRowCount = (seedSql.match(/^INSERT /gm) || []).length;
    }

    // Resolve live URL from subdomain or deployment
    let liveUrl: string | null = null;
    const subdomainResult = await pool.query(
      sql(`SELECT name FROM internal.subdomains WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`),
      [projectId],
    );
    if (subdomainResult.rows.length > 0) {
      liveUrl = getSubdomainUrl(subdomainResult.rows[0].name as string);
    } else if (siteDeploymentId) {
      liveUrl = getDeploymentUrl(siteDeploymentId as string);
    }

    // Compute stats and derived min tier
    const functionCount = functionsResult.rows.length;
    const derivedMinTier = computeDerivedMinTier(functionCount, siteTotalBytes);

    // Delete previous version(s) — we keep only one snapshot per project
    const oldVersions = await pool.query(
      sql(`SELECT id, version, bundle_uri, site_deployment_id
       FROM internal.app_versions WHERE project_id = $1
       ORDER BY version DESC`),
      [projectId],
    );
    const maxOldVersion = oldVersions.rows.length > 0 ? (oldVersions.rows[0].version as number) : 0;
    for (const old of oldVersions.rows) {
      await deleteBundle(old.bundle_uri as string);
      if (old.site_deployment_id) {
        await pool.query(
          sql(`UPDATE internal.deployments SET ref_count = GREATEST(ref_count - 1, 0) WHERE id = $1`),
          [old.site_deployment_id],
        );
      }
    }
    if (oldVersions.rows.length > 0) {
      await pool.query(
        sql(`DELETE FROM internal.app_versions WHERE project_id = $1`),
        [projectId],
      );
    }
    const version = maxOldVersion + 1;

    // Build bundle artifact
    const versionId = generateVersionId();
    const bundle = {
      format_version: 1,
      pre_schema_sql: preSchemaSql,
      post_schema_sql: postSchemaSql,
      seed_sql: seedSql,
      schema_placeholder: "__SCHEMA__",
    };
    const bundleJson = JSON.stringify(bundle);
    const bundleSha256 = createHash("sha256").update(bundleJson).digest("hex");

    // Persist bundle artifact
    const bundleKey = `app-versions/${versionId}/bundle.json`;
    let bundleUri: string;
    if (s3 && S3_BUCKET) {
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: bundleKey,
        Body: bundleJson,
        ContentType: "application/json",
      }));
      bundleUri = `s3://${S3_BUCKET}/${bundleKey}`;
    } else {
      const localPath = join(LOCAL_STORAGE_ROOT, bundleKey);
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, bundleJson);
      bundleUri = `local://${bundleKey}`;
    }

    // Insert app version
    const visibility = options.visibility || "private";
    const forkAllowed = options.fork_allowed || false;
    const requiredSecrets = options.required_secrets || [];
    const requiredActions = options.required_actions || [];

    // Parse bootstrap variables from options (from run402.yaml)
    const bootstrapVariables = options.bootstrap_variables || null;

    await pool.query(
      sql(`INSERT INTO internal.app_versions
       (id, project_id, version, name, description, visibility, fork_allowed, status,
        min_tier, derived_min_tier, format_version, bundle_uri, bundle_sha256,
        publisher_wallet, required_secrets, required_actions, tags, live_url,
        table_count, function_count, site_file_count, site_total_bytes, seed_row_count,
        site_deployment_id, bootstrap_variables)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'published',
        $8, $9, 1, $10, $11,
        $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21,
        $22, $23)`),
      [
        versionId, projectId, version, projectName, options.description || null,
        visibility, forkAllowed,
        derivedMinTier, derivedMinTier, bundleUri, bundleSha256,
        publisherWallet || null, JSON.stringify(requiredSecrets), JSON.stringify(requiredActions), tags, liveUrl,
        tableCount, functionCount, siteFileCount, siteTotalBytes, seedRowCount,
        siteDeploymentId, bootstrapVariables ? JSON.stringify(bootstrapVariables) : null,
      ],
    );

    // Insert function sources
    for (const fn of functionsResult.rows) {
      await pool.query(
        sql(`INSERT INTO internal.app_version_functions
         (version_id, name, source, runtime, timeout_seconds, memory_mb, deps, code_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`),
        [versionId, fn.name, fn.source, fn.runtime, fn.timeout_seconds, fn.memory_mb, fn.deps || [], fn.code_hash],
      );
    }

    // Pin site deployment (increment ref_count)
    if (siteDeploymentId) {
      await pool.query(
        sql(`UPDATE internal.deployments SET ref_count = ref_count + 1 WHERE id = $1`),
        [siteDeploymentId],
      );
    }

    console.log(`  Published version ${versionId} for ${projectId} (v${version}, ${tableCount} tables, ${functionCount} functions)`);

    return {
      id: versionId,
      project_id: projectId,
      version,
      name: projectName,
      description: options.description || null,
      visibility,
      fork_allowed: forkAllowed,
      min_tier: derivedMinTier,
      derived_min_tier: derivedMinTier,
      status: "published",
      table_count: tableCount,
      function_count: functionCount,
      site_file_count: siteFileCount,
      site_total_bytes: siteTotalBytes,
      required_secrets: requiredSecrets,
      required_actions: requiredActions,
      tags,
      live_url: liveUrl,
      bootstrap_variables: bootstrapVariables || null,
      created_at: new Date().toISOString(),
      compatibility_warnings: warnings,
    };
  } finally {
    await pool.query(sql(`SELECT pg_advisory_unlock($1)`), [lockId]);
  }
}

/**
 * List published versions for a project.
 */
export async function listVersions(projectId: string): Promise<AppVersionInfo[]> {
  const result = await pool.query(
    sql(`SELECT id, project_id, version, name, description, visibility, fork_allowed,
            min_tier, derived_min_tier, status,
            table_count, function_count, site_file_count, site_total_bytes,
            required_secrets, required_actions, tags, live_url, created_at
     FROM internal.app_versions WHERE project_id = $1 ORDER BY version DESC`),
    [projectId],
  );
  return result.rows.map(mapRowToAppVersion);
}

/**
 * List all public forkable app versions, optionally filtered by tags.
 */
export async function listPublicApps(filterTags?: string[]): Promise<AppVersionInfo[]> {
  let query = `SELECT id, project_id, version, name, description, visibility, fork_allowed,
            min_tier, derived_min_tier, status,
            table_count, function_count, site_file_count, site_total_bytes,
            required_secrets, required_actions, tags, live_url, site_deployment_id, created_at
     FROM internal.app_versions
     WHERE visibility IN ('public', 'unlisted') AND status = 'published'`;
  const params: string[][] = [];

  if (filterTags && filterTags.length > 0) {
    query += ` AND tags @> $1`;
    params.push(filterTags);
  }

  query += ` ORDER BY created_at DESC LIMIT 100`;

  const result = await pool.query(sql(query), params.length > 0 ? params : undefined);
  return result.rows.map(mapRowToAppVersion);
}

function mapRowToAppVersion(row: Record<string, unknown>): AppVersionInfo {
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    version: row.version as number,
    name: row.name as string,
    description: row.description as string | null,
    visibility: row.visibility as string,
    fork_allowed: row.fork_allowed as boolean,
    min_tier: row.min_tier as TierName,
    derived_min_tier: row.derived_min_tier as TierName,
    status: row.status as string,
    table_count: row.table_count as number,
    function_count: row.function_count as number,
    site_file_count: row.site_file_count as number,
    site_total_bytes: Number(row.site_total_bytes),
    required_secrets: (row.required_secrets || []) as Array<{ key: string; description?: string }>,
    required_actions: (row.required_actions || []) as Array<{ action: string; description?: string }>,
    tags: (row.tags || []) as string[],
    live_url: (row.live_url as string) || null,
    bootstrap_variables: (row.bootstrap_variables as unknown[]) || null,
    created_at: row.created_at as string,
    compatibility_warnings: [],
  };
}

/**
 * Get a public app version by ID.
 */
export async function getAppVersion(versionId: string): Promise<AppVersionInfo | null> {
  const result = await pool.query(
    sql(`SELECT id, project_id, version, name, description, visibility, fork_allowed,
            min_tier, derived_min_tier, status,
            table_count, function_count, site_file_count, site_total_bytes,
            required_secrets, required_actions, tags, live_url, bootstrap_variables, created_at
     FROM internal.app_versions WHERE id = $1`),
    [versionId],
  );
  if (result.rows.length === 0) return null;
  return mapRowToAppVersion(result.rows[0]);
}

/**
 * Delete a published app version. Decrements site deployment ref_count.
 */
export async function deleteAppVersion(versionId: string, projectId: string): Promise<boolean> {
  // Get metadata before deleting
  const verResult = await pool.query(
    sql(`SELECT site_deployment_id, bundle_uri FROM internal.app_versions WHERE id = $1 AND project_id = $2`),
    [versionId, projectId],
  );
  if (verResult.rows.length === 0) return false;

  const { site_deployment_id: siteDeploymentId, bundle_uri: bundleUri } = verResult.rows[0];

  // Delete (cascades to app_version_functions)
  const delResult = await pool.query(
    sql(`DELETE FROM internal.app_versions WHERE id = $1 AND project_id = $2`),
    [versionId, projectId],
  );
  if (!delResult.rowCount || delResult.rowCount === 0) return false;

  // Clean up S3 bundle
  if (bundleUri) await deleteBundle(bundleUri as string);

  // Decrement site deployment ref_count
  if (siteDeploymentId) {
    await pool.query(
      sql(`UPDATE internal.deployments SET ref_count = GREATEST(ref_count - 1, 0) WHERE id = $1`),
      [siteDeploymentId],
    );
  }

  console.log(`  Deleted app version ${versionId}`);
  return true;
}
