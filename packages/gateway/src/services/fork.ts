/**
 * Fork service — instantiate a new project from a published App Version.
 *
 * Loads the published bundle, converts it to a bundle deploy request,
 * and calls the existing deployBundle() orchestrator. Applies post-schema
 * SQL (indexes, RLS) and seed data after the initial deploy.
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pool } from "../db/pool.js";
import { S3_BUCKET, S3_REGION } from "../config.js";

const execFileAsync = promisify(execFile);
import { TIERS } from "@run402/shared";
import type { TierName } from "@run402/shared";
import { deployBundle } from "./bundle.js";
import { decanonicalizeSchema } from "./publish.js";
import type { BundleResult } from "./bundle.js";

const s3 = S3_BUCKET ? new S3Client({ region: S3_REGION }) : null;

// Tier ordering for comparison
const TIER_ORDER: Record<string, number> = { prototype: 0, hobby: 1, team: 2 };

export class ForkError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}

export interface ForkRequest {
  version_id: string;
  name: string;
  subdomain?: string;
}

export interface ForkResult extends BundleResult {
  source_version_id: string;
  readiness: "ready" | "configuration_required" | "manual_setup_required";
  missing_secrets: Array<{ key: string; description?: string }>;
  required_actions: Array<{ action: string; description?: string }>;
}

/**
 * Validate a fork request.
 */
export function validateForkRequest(req: ForkRequest): void {
  if (!req.version_id || typeof req.version_id !== "string") {
    throw new ForkError("Missing or invalid 'version_id'", 400);
  }
  if (!req.name || typeof req.name !== "string") {
    throw new ForkError("Missing or invalid 'name'", 400);
  }
}

/**
 * Fork an app version into a new project.
 */
export async function forkApp(
  req: ForkRequest,
  tier: TierName,
  apiBase: string,
  txHash?: string,
  walletAddress?: string,
): Promise<ForkResult> {
  // Load app version metadata
  const versionResult = await pool.query(
    `SELECT id, project_id, name, visibility, fork_allowed, status,
            min_tier, derived_min_tier, bundle_uri, bundle_sha256,
            required_secrets, required_actions, site_deployment_id
     FROM internal.app_versions WHERE id = $1`,
    [req.version_id],
  );
  if (versionResult.rows.length === 0) {
    throw new ForkError("App version not found", 404);
  }

  const version = versionResult.rows[0];

  // Validate forkability
  if (version.status !== "published") {
    throw new ForkError("App version is not published", 400);
  }
  if (!version.fork_allowed) {
    throw new ForkError("App version does not allow forking", 403);
  }
  if (version.visibility === "private") {
    throw new ForkError("Cannot fork a private app version", 403);
  }

  // Validate tier meets minimum
  const effectiveMinTier = TIER_ORDER[version.derived_min_tier] > TIER_ORDER[version.min_tier]
    ? version.derived_min_tier
    : version.min_tier;
  if (TIER_ORDER[tier] < TIER_ORDER[effectiveMinTier]) {
    throw new ForkError(
      `Tier '${tier}' is below minimum required tier '${effectiveMinTier}' for this app`,
      400,
    );
  }

  // Load bundle from S3
  const bundleKey = version.bundle_uri.replace(`s3://${S3_BUCKET}/`, "");
  let bundleJson: string;

  if (s3 && S3_BUCKET) {
    const obj = await s3.send(new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: bundleKey,
    }));
    bundleJson = await obj.Body!.transformToString();
  } else {
    throw new ForkError("S3 not configured", 503);
  }

  // Verify integrity
  const actualHash = await import("node:crypto")
    .then((c) => c.createHash("sha256").update(bundleJson).digest("hex"));
  if (actualHash !== version.bundle_sha256) {
    throw new ForkError("Bundle integrity check failed", 500);
  }

  const bundle = JSON.parse(bundleJson) as {
    pre_schema_sql: string;
    post_schema_sql: string;
    seed_sql: string | null;
  };

  // Load function sources
  const functionsResult = await pool.query(
    `SELECT name, source, runtime, timeout_seconds, memory_mb, deps
     FROM internal.app_version_functions WHERE version_id = $1`,
    [req.version_id],
  );

  // Build bundle deploy request using pre_schema as migrations
  // (post_schema applied after deploy since it needs tables to exist first)
  const bundleReq = {
    name: req.name,
    tier,
    migrations: undefined as string | undefined,
    functions: functionsResult.rows.map((fn) => ({
      name: fn.name,
      code: fn.source,
      config: { timeout: fn.timeout_seconds, memory: fn.memory_mb },
    })),
    site: undefined as Array<{ file: string; data: string }> | undefined,
    subdomain: req.subdomain,
  };

  // Call the existing bundle deploy orchestrator
  // pre_schema_sql is applied as migrations inside deployBundle
  const result = await deployBundle(
    { ...bundleReq, migrations: undefined },
    apiBase,
    txHash,
    walletAddress,
  );

  // Now apply schema in the new project's schema slot
  // We need to get the schema slot from the newly created project
  const projectResult = await pool.query(
    `SELECT schema_slot FROM internal.projects WHERE id = $1`,
    [result.project_id],
  );
  const targetSchema = projectResult.rows[0].schema_slot;

  // Apply schema SQL via psql (handles multi-statement pg_dump output correctly)
  const sqlPhases = [
    { label: "pre-schema", sql: bundle.pre_schema_sql },
    { label: "seed", sql: bundle.seed_sql },
    { label: "post-schema", sql: bundle.post_schema_sql },
  ];

  for (const phase of sqlPhases) {
    if (!phase.sql?.trim()) continue;
    const sql = decanonicalizeSchema(phase.sql, targetSchema);
    await executeSqlViaPsql(sql, `fork ${phase.label}`);
  }

  // Notify PostgREST to reload schema cache
  await pool.query("NOTIFY pgrst, 'reload schema'");

  // Record provenance
  await pool.query(
    `UPDATE internal.projects SET source_version_id = $1 WHERE id = $2`,
    [req.version_id, result.project_id],
  );

  // Determine readiness
  const requiredSecrets = version.required_secrets || [];
  const requiredActions = version.required_actions || [];
  let readiness: "ready" | "configuration_required" | "manual_setup_required" = "ready";
  if (requiredActions.length > 0) {
    readiness = "manual_setup_required";
  } else if (requiredSecrets.length > 0) {
    readiness = "configuration_required";
  }

  console.log(`  Forked ${req.version_id} → ${result.project_id} (${tier}, readiness: ${readiness})`);

  return {
    ...result,
    source_version_id: req.version_id,
    readiness,
    missing_secrets: requiredSecrets,
    required_actions: requiredActions,
  };
}

/**
 * Execute multi-statement SQL via psql (handles pg_dump output correctly).
 */
async function executeSqlViaPsql(sql: string, label: string): Promise<void> {
  const dbHost = process.env.DB_HOST || "localhost";
  const dbPort = process.env.DB_PORT || "5432";
  const dbName = process.env.DB_NAME || "agentdb";
  const dbUser = process.env.DB_USER || "postgres";
  const dbPassword = process.env.DB_PASSWORD || "";

  // Write SQL to temp file (psql -f is more reliable than stdin for large scripts)
  const tmpFile = join(tmpdir(), `fork-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmpFile, sql);

  try {
    await execFileAsync("psql", [
      `--host=${dbHost}`,
      `--port=${dbPort}`,
      `--username=${dbUser}`,
      `--dbname=${dbName}`,
      "--no-psqlrc",
      "--set=ON_ERROR_STOP=1",
      `-f`, tmpFile,
    ], {
      env: { ...process.env, PGPASSWORD: dbPassword },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ForkError(`Fork ${label} failed: ${msg}`, 500);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* best effort cleanup */ }
  }
}
