import jwt from "jsonwebtoken";
import { pool } from "../db/pool.js";
import { sql, type SQL } from "../db/sql.js";
import { JWT_SECRET } from "../config.js";
import { allocateSlot } from "./slots.js";
import { deleteProjectFunctions } from "./functions.js";
import { deleteProjectSubdomains } from "./subdomains.js";
import { deleteProjectDeployments } from "./deployments.js";
import { tombstoneProjectMailbox } from "./mailbox.js";
import { removeSenderDomain } from "./email-domains.js";
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
 * Sync all non-terminal projects from database into cache.
 *
 * Includes `active` and all lifecycle grace states (`past_due`, `frozen`,
 * `dormant`) so that data-plane traffic continues to resolve during grace.
 * The control-plane write gate (middleware/lifecycle-gate.ts) separately
 * blocks mutating admin operations on non-active projects.
 */
export async function syncProjects(): Promise<void> {
  const result = await pool.query(
    sql(`SELECT id, name, schema_slot, tier, status, api_calls, storage_bytes,
            tx_hash, wallet_address, pinned, created_at,
            demo_mode, demo_config, demo_source_version_id, demo_last_reset_at
     FROM internal.projects WHERE status IN ('active', 'past_due', 'frozen', 'dormant')`),
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
      allowPasswordSet: row.allow_password_set || false,
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
    sql(`SELECT id, name, schema_slot, tier, status, api_calls, storage_bytes,
            tx_hash, wallet_address, pinned, created_at,
            demo_mode, demo_config, demo_source_version_id, demo_last_reset_at
     FROM internal.projects WHERE id = $1`),
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
    allowPasswordSet: row.allow_password_set || false,
  };

  // Cache all non-terminal projects so data-plane lookups stay hot during grace.
  if (project.status === "active" || project.status === "past_due" ||
      project.status === "frozen" || project.status === "dormant") {
    cache.set(id, project);
  }

  return project;
}

/**
 * Return true for projects whose data plane should keep serving end users.
 * False for terminal states (purging/purged/archived/expired/deleted).
 */
export function isServingStatus(status: string): boolean {
  return status === "active" || status === "past_due" ||
         status === "frozen" || status === "dormant";
}

/**
 * Derive project JWT keys. Neither key has an exp claim — lease/lifecycle
 * enforcement happens in apikeyAuth/serviceKeyAuth middleware via projectCache
 * + isServingStatus + lifecycleGate, not in the JWT.
 */
export function deriveProjectKeys(projectId: string, _tier: TierName): { anonKey: string; serviceKey: string } {
  const anonKey = jwt.sign(
    { role: "anon", project_id: projectId, iss: "agentdb" },
    JWT_SECRET,
  );
  const serviceKey = jwt.sign(
    { role: "service_role", project_id: projectId, iss: "agentdb" },
    JWT_SECRET,
  );
  return { anonKey, serviceKey };
}

/**
 * Drop and recreate a schema slot, granting the standard roles.
 * Used by both createProject (defensive cleanup) and purgeProject.
 */
async function resetSchemaSlot(client: { query(q: SQL, v?: unknown[]): Promise<unknown> }, slot: string): Promise<void> {
  await client.query(sql(`DROP SCHEMA IF EXISTS ${slot} CASCADE`));
  await client.query(sql(`CREATE SCHEMA ${slot}`));
  await client.query(sql(`GRANT USAGE ON SCHEMA ${slot} TO anon, authenticated, service_role`));
  await client.query(
    sql(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${slot} GRANT SELECT ON TABLES TO anon`),
  );
  await client.query(
    sql(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${slot} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated`),
  );
  await client.query(
    sql(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${slot} GRANT ALL ON TABLES TO service_role`),
  );
  await client.query(
    sql(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${slot} GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role`),
  );
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
  const projectId = `prj_${Date.now()}_${schemaSlot.replace("p", "")}`;

  // Both keys are stateless JWTs with no exp — lease/lifecycle enforcement
  // happens in apikeyAuth/serviceKeyAuth middleware, not in the JWT.
  const anonKey = jwt.sign(
    { role: "anon", project_id: projectId, iss: "agentdb" },
    JWT_SECRET,
  );
  const serviceKey = jwt.sign(
    { role: "service_role", project_id: projectId, iss: "agentdb" },
    JWT_SECRET,
  );

  // Defensive: ensure the schema slot is clean before use.
  // purgeProject should have cleaned it, but if that transaction rolled back
  // (or the slot was recycled via direct DB update) stale tables may remain.
  await resetSchemaSlot(pool, schemaSlot);

  await pool.query(
    sql(`INSERT INTO internal.projects
     (id, name, schema_slot, tier, status, tx_hash, wallet_address)
     VALUES ($1, $2, $3, $4, 'active', $5, $6)`),
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
    allowPasswordSet: false,
  };

  cache.set(projectId, project);
  return project;
}

/**
 * Purge a project: run the full destructive cascade (delete Lambdas, release
 * subdomains, drop the tenant schema, tombstone mailbox, etc.) and mark the
 * project `purged`. Called by (a) explicit DELETE /projects/v1/:id and
 * (b) the terminal dormant → purged transition driven by project-lifecycle.
 *
 * For compatibility, a project already in terminal state (`purged` or the
 * legacy `archived`) returns false without re-running the cascade.
 */
export async function purgeProject(projectId: string): Promise<boolean> {
  // Accept any non-terminal status. Dormant/frozen/past_due projects may not
  // be in the active cache, so consult the DB via getProjectById.
  const project = await getProjectById(projectId);
  if (!project) return false;
  if (project.status === "purged" || project.status === "archived") return false;

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

  // 5. Remove custom sender domain (SES identity cleaned up if last project using it)
  try {
    await removeSenderDomain(projectId);
  } catch (err) {
    console.error(`  Warning: cascade removeSenderDomain failed for ${projectId}:`, err instanceof Error ? err.message : err);
  }

  // 6. Delete DB-only resources (secrets, app versions, oauth transactions)
  try {
    await pool.query(sql(`DELETE FROM internal.secrets WHERE project_id = $1`), [projectId]);
    await pool.query(sql(`DELETE FROM internal.app_versions WHERE project_id = $1`), [projectId]);
    await pool.query(sql(`DELETE FROM internal.oauth_transactions WHERE project_id = $1`), [projectId]);
  } catch (err) {
    console.error(`  Warning: cascade DB cleanup failed for ${projectId}:`, err instanceof Error ? err.message : err);
  }

  // --- Existing schema drop + archive logic ---

  const client = await pool.connect();
  try {
    await client.query(sql("BEGIN"));

    // Drop and recreate schema slot
    await resetSchemaSlot(client, project.schemaSlot);

    // Delete project users
    await client.query(sql(`DELETE FROM internal.users WHERE project_id = $1`), [projectId]);
    // Delete refresh tokens
    await client.query(sql(`DELETE FROM internal.refresh_tokens WHERE project_id = $1`), [projectId]);

    // Mark purged (terminal state under the lifecycle state machine)
    await client.query(
      sql(`UPDATE internal.projects SET status = 'purged' WHERE id = $1`),
      [projectId],
    );

    await client.query(sql("COMMIT"));
  } catch (err) {
    await client.query(sql("ROLLBACK"));
    throw err;
  } finally {
    client.release();
  }

  project.status = "purged";
  cache.delete(projectId);
  return true;
}

