/**
 * Demo service — create, reset, and teardown demo projects.
 *
 * Demo projects are live interactive instances of published apps.
 * They reset periodically to the published snapshot.
 */

import { S3Client, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { S3_BUCKET, S3_REGION } from "../config.js";
import { projectCache } from "./projects.js";
import { forkApp } from "./fork.js";
import { executeSqlViaPsql } from "./fork.js";
import { decanonicalizeSchema } from "./publish.js";
import { resetDemoCounters, setDemoMaintenance } from "../middleware/demo.js";
import { DEFAULT_DEMO_CONFIG } from "@run402/shared";
import type { DemoConfig } from "@run402/shared";
import { errorMessage } from "../utils/errors.js";

const s3 = S3_BUCKET ? new S3Client({ region: S3_REGION }) : null;

/**
 * Create a demo project for a newly published app version.
 * Forks the published bundle into a platform-operated demo project.
 */
export async function createDemoProject(
  versionId: string,
  appName: string,
  apiBase: string,
): Promise<string> {
  console.log(`  Creating demo project for version ${versionId}...`);

  const result = await forkApp(
    { version_id: versionId, name: `demo-${appName}` },
    "prototype",
    apiBase,
  );

  const config = DEFAULT_DEMO_CONFIG;

  await pool.query(
    sql(`UPDATE internal.projects
     SET demo_mode = true, pinned = true,
         demo_source_version_id = $1, demo_config = $2, demo_last_reset_at = NOW()
     WHERE id = $3`),
    [versionId, JSON.stringify(config), result.project_id],
  );

  // Update cache
  const project = projectCache.get(result.project_id);
  if (project) {
    project.demoMode = true;
    project.pinned = true;
    project.demoConfig = config;
    project.demoSourceVersionId = versionId;
    project.demoLastResetAt = new Date();
  }

  console.log(`  Demo project created: ${result.project_id} for version ${versionId}`);
  return result.project_id;
}

/**
 * Reset a demo project to its published snapshot.
 * Drops schema, restores from bundle, resets counters.
 */
export async function resetDemoProject(projectId: string): Promise<void> {
  const project = projectCache.get(projectId);
  if (!project?.demoMode || !project.demoSourceVersionId) return;

  console.log(`  Resetting demo project ${projectId}...`);
  setDemoMaintenance(projectId, true);

  try {
    // Load the published bundle
    const versionResult = await pool.query(
      sql(`SELECT bundle_uri, bundle_sha256 FROM internal.app_versions WHERE id = $1`),
      [project.demoSourceVersionId],
    );
    if (versionResult.rows.length === 0) {
      console.error(`  Demo reset failed: version ${project.demoSourceVersionId} not found`);
      return;
    }

    const version = versionResult.rows[0];
    const bundleKey = version.bundle_uri.replace(`s3://${S3_BUCKET}/`, "");

    if (!s3 || !S3_BUCKET) {
      console.error("  Demo reset failed: S3 not configured");
      return;
    }

    const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: bundleKey }));
    const bundleJson = await obj.Body!.transformToString();

    // Verify integrity
    const crypto = await import("node:crypto");
    const actualHash = crypto.createHash("sha256").update(bundleJson).digest("hex");
    if (actualHash !== version.bundle_sha256) {
      console.error(`  Demo reset failed: bundle integrity check failed for ${projectId}`);
      return;
    }

    const bundle = JSON.parse(bundleJson) as {
      pre_schema_sql: string;
      post_schema_sql: string;
      seed_sql: string | null;
    };

    // 1. Drop and recreate schema
    const client = await pool.connect();
    try {
      await client.query(sql("BEGIN"));
      await client.query(sql(`DROP SCHEMA IF EXISTS ${project.schemaSlot} CASCADE`));
      await client.query(sql(`CREATE SCHEMA ${project.schemaSlot}`));
      await client.query(sql(`GRANT USAGE ON SCHEMA ${project.schemaSlot} TO anon, authenticated, service_role`));
      await client.query(
        sql(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${project.schemaSlot} GRANT SELECT ON TABLES TO anon`),
      );
      await client.query(
        sql(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${project.schemaSlot} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated`),
      );
      await client.query(
        sql(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${project.schemaSlot} GRANT ALL ON TABLES TO service_role`),
      );
      await client.query(
        sql(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${project.schemaSlot} GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role`),
      );

      // Delete auth users and refresh tokens
      await client.query(sql(`DELETE FROM internal.users WHERE project_id = $1`), [projectId]);
      await client.query(sql(`DELETE FROM internal.refresh_tokens WHERE project_id = $1`), [projectId]);

      await client.query(sql("COMMIT"));
    } catch (err) {
      await client.query(sql("ROLLBACK"));
      throw err;
    } finally {
      client.release();
    }

    // 2. Restore bundle SQL via psql
    const sqlPhases = [
      { label: "pre-schema", sql: bundle.pre_schema_sql },
      { label: "seed", sql: bundle.seed_sql },
      { label: "post-schema", sql: bundle.post_schema_sql },
    ];

    for (const phase of sqlPhases) {
      if (!phase.sql?.trim()) continue;
      const sql = decanonicalizeSchema(phase.sql, project.schemaSlot);
      await executeSqlViaPsql(sql, `demo-reset ${phase.label}`);
    }

    // 3. Re-apply table grants
    const tablesResult = await pool.query(
      sql(`SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'`),
      [project.schemaSlot],
    );
    if (tablesResult.rows.length > 0) {
      const grantClient = await pool.connect();
      try {
        for (const row of tablesResult.rows) {
          const t = `${project.schemaSlot}.${row.table_name}`;
          await grantClient.query(sql(`GRANT SELECT ON ${t} TO anon`));
          await grantClient.query(sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO authenticated`));
          await grantClient.query(sql(`GRANT ALL ON ${t} TO service_role`));
        }
        const seqResult = await pool.query(
          sql(`SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = $1`),
          [project.schemaSlot],
        );
        for (const row of seqResult.rows) {
          const s = `${project.schemaSlot}.${row.sequence_name}`;
          await grantClient.query(sql(`GRANT USAGE, SELECT ON SEQUENCE ${s} TO anon, authenticated, service_role`));
        }
      } finally {
        grantClient.release();
      }
    }

    // 4. Notify PostgREST
    await pool.query(sql("NOTIFY pgrst, 'reload schema'"));

    // 5. Delete visitor storage uploads
    if (s3 && S3_BUCKET) {
      try {
        const prefix = `${projectId}/`;
        const listResult = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix }));
        for (const obj of listResult.Contents || []) {
          if (obj.Key && !obj.Key.includes("app-versions/")) {
            await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
          }
        }
      } catch (err) {
        console.warn(`  Demo reset: failed to clean storage for ${projectId}:`, errorMessage(err));
      }
    }

    // 6. Reset counters and update timestamp
    resetDemoCounters(projectId);
    await pool.query(
      sql(`UPDATE internal.projects SET demo_last_reset_at = NOW() WHERE id = $1`),
      [projectId],
    );
    project.demoLastResetAt = new Date();

    console.log(`  Demo project ${projectId} reset successfully`);
  } catch (err) {
    console.error(`  Demo reset failed for ${projectId}:`, errorMessage(err));
  } finally {
    setDemoMaintenance(projectId, false);
  }
}

/**
 * Teardown a demo project (when app is unpublished/deleted).
 */
export async function teardownDemoProject(sourceProjectId: string): Promise<void> {
  // Find the demo project for this source project's published version
  const result = await pool.query(
    sql(`SELECT p.id FROM internal.projects p
     JOIN internal.app_versions av ON p.demo_source_version_id = av.id
     WHERE av.project_id = $1 AND p.demo_mode = true AND p.status = 'active'`),
    [sourceProjectId],
  );

  for (const row of result.rows) {
    const demoProjectId = row.id;
    console.log(`  Tearing down demo project ${demoProjectId}...`);

    // Archive the demo project (drops schema, marks inactive)
    const { archiveProject } = await import("./projects.js");
    await archiveProject(demoProjectId);

    // Release subdomain
    try {
      await pool.query(sql(`DELETE FROM internal.subdomains WHERE project_id = $1`), [demoProjectId]);
    } catch (err) {
      console.warn(`  Failed to release demo subdomain for ${demoProjectId}:`, errorMessage(err));
    }

    // Clean up storage
    if (s3 && S3_BUCKET) {
      try {
        const prefix = `${demoProjectId}/`;
        const listResult = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix }));
        for (const obj of listResult.Contents || []) {
          if (obj.Key) {
            await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
          }
        }
      } catch (err) {
        console.warn(`  Failed to clean demo storage for ${demoProjectId}:`, errorMessage(err));
      }
    }

    resetDemoCounters(demoProjectId);
    console.log(`  Demo project ${demoProjectId} torn down`);
  }
}

/**
 * Find existing demo project for a source project.
 */
export async function findDemoProject(sourceProjectId: string): Promise<string | null> {
  const result = await pool.query(
    sql(`SELECT p.id FROM internal.projects p
     JOIN internal.app_versions av ON p.demo_source_version_id = av.id
     WHERE av.project_id = $1 AND p.demo_mode = true AND p.status = 'active'
     LIMIT 1`),
    [sourceProjectId],
  );
  return result.rows.length > 0 ? result.rows[0].id : null;
}

/**
 * Update a demo project to point to a new version and trigger immediate reset.
 */
export async function updateDemoVersion(demoProjectId: string, newVersionId: string): Promise<void> {
  await pool.query(
    sql(`UPDATE internal.projects SET demo_source_version_id = $1 WHERE id = $2`),
    [newVersionId, demoProjectId],
  );

  const project = projectCache.get(demoProjectId);
  if (project) {
    project.demoSourceVersionId = newVersionId;
  }

  // Trigger immediate reset
  await resetDemoProject(demoProjectId);
}

// --- Scheduled task ---

let resetInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Check all demo projects and reset those whose interval has elapsed.
 */
async function checkDemoResets(): Promise<void> {
  const now = Date.now();

  for (const project of projectCache.values()) {
    if (!project.demoMode || project.status !== "active") continue;
    if (!project.demoLastResetAt || !project.demoConfig) continue;

    const intervalMs = project.demoConfig.reset_interval_hours * 3600000;
    const nextReset = project.demoLastResetAt.getTime() + intervalMs;

    if (now >= nextReset) {
      try {
        await resetDemoProject(project.id);
      } catch (err) {
        console.error(`  Demo reset check failed for ${project.id}:`, errorMessage(err));
      }
    }
  }
}

export function startDemoResetChecker(): void {
  // Check every 5 minutes
  resetInterval = setInterval(checkDemoResets, 5 * 60 * 1000);
  console.log("  Demo reset checker started (every 5 minutes)");
}

export function stopDemoResetChecker(): void {
  if (resetInterval) {
    clearInterval(resetInterval);
    resetInterval = null;
  }
}
