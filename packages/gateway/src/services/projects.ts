import jwt from "jsonwebtoken";
import { pool } from "../db/pool.js";
import { JWT_SECRET } from "../config.js";
import { getLeaseDuration } from "@run402/shared";
import { allocateSlot } from "./slots.js";
import { deleteProjectFunctions } from "./functions.js";
import { deleteProjectSubdomains } from "./subdomains.js";
import { deleteProjectDeployments } from "./deployments.js";
import { tombstoneProjectMailbox } from "./mailbox.js";
import type { ProjectInfo, TierName } from "@run402/shared";


// In-memory cache with TTL refresh on access
const cache = new Map<string, ProjectInfo>();
let lastFullSync = 0;
const CACHE_TTL = 60_000; // 60s

export const projectCache = {
  get(id: string): ProjectInfo | undefined {
    return cache.get(id);
  },
  set(id: string, project: ProjectInfo): void {
    cache.set(id, project);
  },
  delete(id: string): void {
    cache.delete(id);
  },
  values(): IterableIterator<ProjectInfo> {
    return cache.values();
  },
};

/**
 * Sync all active projects from database into cache.
 */
export async function syncProjects(): Promise<void> {
  const result = await pool.query(
    `SELECT id, name, schema_slot, tier, status, api_calls, storage_bytes,
            tx_hash, wallet_address, pinned, created_at,
            demo_mode, demo_config, demo_source_version_id, demo_last_reset_at
     FROM internal.projects WHERE status = 'active'`,
  );

  for (const row of result.rows) {
    cache.set(row.id, {
      id: row.id,
      name: row.name,
      schemaSlot: row.schema_slot,
      tier: row.tier as TierName,
      status: row.status,
      anonKey: "", // Not stored; keys are JWTs signed on creation
      serviceKey: "",
      apiCalls: row.api_calls,
      storageBytes: Number(row.storage_bytes),
      txHash: row.tx_hash,
      walletAddress: row.wallet_address || undefined,
      pinned: row.pinned || false,
      createdAt: new Date(row.created_at),
      demoMode: row.demo_mode || false,
      demoConfig: row.demo_config || undefined,
      demoSourceVersionId: row.demo_source_version_id || undefined,
      demoLastResetAt: row.demo_last_reset_at ? new Date(row.demo_last_reset_at) : undefined,
    });
  }

  lastFullSync = Date.now();
  console.log(`  Synced ${result.rows.length} active project(s) into cache`);
}

/**
 * Look up a project by ID: cache-first, DB fallback.
 */
export async function getProjectById(id: string): Promise<ProjectInfo | null> {
  const cached = cache.get(id);
  if (cached) return cached;

  const result = await pool.query(
    `SELECT id, name, schema_slot, tier, status, api_calls, storage_bytes,
            tx_hash, wallet_address, pinned, created_at,
            demo_mode, demo_config, demo_source_version_id, demo_last_reset_at
     FROM internal.projects WHERE id = $1`,
    [id],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const project: ProjectInfo = {
    id: row.id,
    name: row.name,
    schemaSlot: row.schema_slot,
    tier: row.tier as TierName,
    status: row.status,
    anonKey: "",
    serviceKey: "",
    apiCalls: row.api_calls,
    storageBytes: Number(row.storage_bytes),
    txHash: row.tx_hash,
    walletAddress: row.wallet_address || undefined,
    pinned: row.pinned || false,
    createdAt: new Date(row.created_at),
    demoMode: row.demo_mode || false,
    demoConfig: row.demo_config || undefined,
    demoSourceVersionId: row.demo_source_version_id || undefined,
    demoLastResetAt: row.demo_last_reset_at ? new Date(row.demo_last_reset_at) : undefined,
  };

  if (project.status === "active") {
    cache.set(id, project);
  }

  return project;
}

/**
 * Derive project JWT keys. Anon key is deterministic (no exp).
 */
export function deriveProjectKeys(projectId: string, tier: TierName): { anonKey: string; serviceKey: string } {
  const leaseMs = getLeaseDuration(tier);
  const anonKey = jwt.sign(
    { role: "anon", project_id: projectId, iss: "agentdb" },
    JWT_SECRET,
  );
  const serviceKey = jwt.sign(
    { role: "service_role", project_id: projectId, iss: "agentdb" },
    JWT_SECRET,
    { expiresIn: `${Math.floor(leaseMs / 1000)}s` },
  );
  return { anonKey, serviceKey };
}

/**
 * Create a new project: allocate slot, sign keys, persist to DB.
 */
export async function createProject(
  name: string,
  tier: TierName,
  txHash?: string,
  walletAddress?: string,
): Promise<ProjectInfo | null> {
  const schemaSlot = await allocateSlot();
  if (!schemaSlot) return null;

  const now = new Date();
  const leaseMs = getLeaseDuration(tier);
  const projectId = `prj_${Date.now()}_${schemaSlot.replace("p", "")}`;

  const anonKey = jwt.sign(
    { role: "anon", project_id: projectId, iss: "agentdb" },
    JWT_SECRET,
  );
  const serviceKey = jwt.sign(
    { role: "service_role", project_id: projectId, iss: "agentdb" },
    JWT_SECRET,
    { expiresIn: `${Math.floor(leaseMs / 1000)}s` },
  );

  await pool.query(
    `INSERT INTO internal.projects
     (id, name, schema_slot, tier, status, tx_hash, wallet_address)
     VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
    [projectId, name, schemaSlot, tier, txHash || null, walletAddress || null],
  );

  const project: ProjectInfo = {
    id: projectId,
    name,
    schemaSlot,
    tier,
    status: "active",
    anonKey,
    serviceKey,
    apiCalls: 0,
    storageBytes: 0,
    txHash,
    walletAddress,
    pinned: false,
    createdAt: now,
    demoMode: false,
  };

  cache.set(projectId, project);
  return project;
}

/**
 * Archive a project: drop+recreate schema, mark archived.
 */
export async function archiveProject(projectId: string): Promise<boolean> {
  const project = cache.get(projectId);
  if (!project || project.status !== "active") return false;

  // --- Cascade cleanup (best-effort, before schema drop) ---

  // 1. Delete Lambda functions + DB rows
  try {
    await deleteProjectFunctions(projectId);
  } catch (err) {
    console.error(`  Warning: cascade deleteProjectFunctions failed for ${projectId}:`, err instanceof Error ? err.message : err);
  }

  // 2. Release subdomains
  try {
    await deleteProjectSubdomains(projectId);
  } catch (err) {
    console.error(`  Warning: cascade deleteProjectSubdomains failed for ${projectId}:`, err instanceof Error ? err.message : err);
  }

  // 3. Delete S3 site files + deployment DB rows
  try {
    await deleteProjectDeployments(projectId);
  } catch (err) {
    console.error(`  Warning: cascade deleteProjectDeployments failed for ${projectId}:`, err instanceof Error ? err.message : err);
  }

  // 4. Tombstone mailbox
  try {
    await tombstoneProjectMailbox(projectId);
  } catch (err) {
    console.error(`  Warning: cascade tombstoneProjectMailbox failed for ${projectId}:`, err instanceof Error ? err.message : err);
  }

  // 5. Delete DB-only resources (secrets, app versions, oauth transactions)
  try {
    await pool.query(`DELETE FROM internal.secrets WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM internal.app_versions WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM internal.oauth_transactions WHERE project_id = $1`, [projectId]);
  } catch (err) {
    console.error(`  Warning: cascade DB cleanup failed for ${projectId}:`, err instanceof Error ? err.message : err);
  }

  // --- Existing schema drop + archive logic ---

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Drop and recreate schema slot
    await client.query(`DROP SCHEMA IF EXISTS ${project.schemaSlot} CASCADE`);
    await client.query(`CREATE SCHEMA ${project.schemaSlot}`);
    await client.query(`GRANT USAGE ON SCHEMA ${project.schemaSlot} TO anon, authenticated, service_role`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${project.schemaSlot} GRANT SELECT ON TABLES TO anon`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${project.schemaSlot} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${project.schemaSlot} GRANT ALL ON TABLES TO service_role`,
    );
    // Sequences (needed for SERIAL/BIGSERIAL columns)
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${project.schemaSlot} GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role`,
    );

    // Delete project users
    await client.query(`DELETE FROM internal.users WHERE project_id = $1`, [projectId]);
    // Delete refresh tokens
    await client.query(`DELETE FROM internal.refresh_tokens WHERE project_id = $1`, [projectId]);

    // Mark archived
    await client.query(
      `UPDATE internal.projects SET status = 'archived' WHERE id = $1`,
      [projectId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  project.status = "archived";
  cache.delete(projectId);
  return true;
}

