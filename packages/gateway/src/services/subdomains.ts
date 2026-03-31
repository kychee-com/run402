/**
 * Subdomain service — claim custom subdomains for deployments.
 *
 * Manages the internal.subdomains table mapping custom names to deployment IDs.
 * Includes an in-memory cache for the hot resolve path.
 */

import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { getDeployment } from "./deployments.js";
import { projectCache, getProjectById } from "./projects.js";
import { kvsPut, kvsDelete, cfInvalidate } from "./kvs.js";
import { updateDomainDeployment, deleteDomainBySubdomain } from "./domains.js";

export interface SubdomainRecord {
  name: string;
  deployment_id: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Reserved subdomain names that cannot be claimed. */
const BLOCKLIST = new Set([
  "api", "www", "mail", "ftp", "admin", "blog", "shop", "store", "app",
  "dashboard", "portal", "status", "docs", "help", "support", "sites",
  "cdn", "static", "assets", "media", "images", "img",
  "ns1", "ns2", "ns3", "ns4", "mx", "smtp", "pop", "imap",
  "dev", "staging", "test", "demo", "beta", "alpha", "preview",
  "run402", "agentdb",
]);

/** Subdomain name validation regex: 3-63 chars, lowercase alphanumeric + hyphens. */
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// ---------- In-memory cache for resolveSubdomain() ----------

const cache = new Map<string, { deploymentId: string; expiresAt: number }>();
const CACHE_TTL_MS = 60_000; // 60 seconds

function cacheSet(name: string, deploymentId: string): void {
  cache.set(name, { deploymentId, expiresAt: Date.now() + CACHE_TTL_MS });
}

function cacheGet(name: string): string | undefined {
  const entry = cache.get(name);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(name);
    return undefined;
  }
  return entry.deploymentId;
}

function cacheInvalidate(name: string): void {
  cache.delete(name);
}

/**
 * Invalidate cache entries for multiple subdomain names.
 * Used by the deployments service after auto-reassignment.
 */
export function cacheInvalidateByNames(names: string[]): void {
  for (const name of names) cache.delete(name);
}

// ---------- Table init ----------

/**
 * Ensure the subdomains table exists (idempotent).
 */
export async function initSubdomainsTable(): Promise<void> {
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.subdomains (
      name         TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      project_id   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));
  await pool.query(sql(`
    CREATE INDEX IF NOT EXISTS idx_subdomains_deployment
      ON internal.subdomains(deployment_id)
  `));
  await pool.query(sql(`
    CREATE INDEX IF NOT EXISTS idx_subdomains_project
      ON internal.subdomains(project_id) WHERE project_id IS NOT NULL
  `));
}

// ---------- Validation ----------

/**
 * Validate a subdomain name. Returns an error message or null if valid.
 */
export function validateSubdomainName(name: string): string | null {
  if (typeof name !== "string") {
    return "Subdomain name must be a string";
  }

  if (name !== name.toLowerCase()) {
    return "Subdomain must be lowercase";
  }

  if (name.length < 3) {
    return "Subdomain must be 3-63 characters";
  }

  if (name.length > 63) {
    return "Subdomain must be 3-63 characters";
  }

  if (!SUBDOMAIN_RE.test(name)) {
    return "Subdomain must contain only lowercase letters, numbers, and hyphens, and must start and end with a letter or number";
  }

  if (name.includes("--")) {
    return "Subdomain must not contain consecutive hyphens";
  }

  if (BLOCKLIST.has(name)) {
    return `Subdomain "${name}" is reserved`;
  }

  return null;
}

// ---------- CRUD ----------

/**
 * Create or update a subdomain mapping.
 * - Verifies the deployment exists
 * - If subdomain exists and belongs to a different project, throws 403
 */
export async function createOrUpdateSubdomain(
  name: string,
  deploymentId: string,
  projectId?: string | null,
  /** If provided, allows cross-project reassignment when the wallet matches. */
  walletAddress?: string,
): Promise<SubdomainRecord> {
  // Verify deployment exists
  const deployment = await getDeployment(deploymentId);
  if (!deployment) {
    throw new SubdomainError(`Deployment "${deploymentId}" not found. Deploy your site first with 'run402 deploy', then claim a subdomain.`, 404);
  }

  // Check ownership if subdomain already exists
  const existing = await getSubdomain(name);
  if (existing && existing.project_id && projectId && existing.project_id !== projectId) {
    // Different project — allow if same wallet is redeploying
    let sameWallet = false;
    if (walletAddress) {
      // Check cache first, fall back to DB (old project may be archived)
      const cached = projectCache.get(existing.project_id);
      const oldWallet = cached?.walletAddress
        ?? (await pool.query(
             sql(`SELECT wallet_address FROM internal.projects WHERE id = $1`),
             [existing.project_id],
           )).rows[0]?.wallet_address;
      if (oldWallet && oldWallet.toLowerCase() === walletAddress.toLowerCase()) {
        sameWallet = true;
      }
    }
    if (!sameWallet) {
      throw new SubdomainError(
        `Subdomain "${name}" is already claimed by another wallet`,
        403,
      );
    }
  }

  const result = await pool.query(
    sql(`INSERT INTO internal.subdomains (name, deployment_id, project_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET
       deployment_id = EXCLUDED.deployment_id,
       project_id = COALESCE(EXCLUDED.project_id, internal.subdomains.project_id),
       updated_at = NOW()
     RETURNING name, deployment_id, project_id, created_at, updated_at`),
    [name, deploymentId, projectId || null],
  );

  const row = result.rows[0];
  cacheInvalidate(name);
  kvsPut(name, deploymentId);
  // Invalidate edge cache on reassignment so redeployed assets are served immediately
  if (existing) cfInvalidate(name);
  // Update Cloudflare KV for any linked custom domain
  updateDomainDeployment(name, deploymentId);

  console.log(`  Subdomain claimed: ${name} → ${deploymentId}`);

  return {
    name: row.name,
    deployment_id: row.deployment_id,
    project_id: row.project_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Get a subdomain record by name, or null if not found.
 */
export async function getSubdomain(name: string): Promise<SubdomainRecord | null> {
  const result = await pool.query(
    sql(`SELECT name, deployment_id, project_id, created_at, updated_at
     FROM internal.subdomains WHERE name = $1`),
    [name],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    name: row.name,
    deployment_id: row.deployment_id,
    project_id: row.project_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * List all subdomains for a project.
 */
export async function listSubdomains(projectId: string): Promise<SubdomainRecord[]> {
  const result = await pool.query(
    sql(`SELECT name, deployment_id, project_id, created_at, updated_at
     FROM internal.subdomains WHERE project_id = $1
     ORDER BY created_at DESC`),
    [projectId],
  );

  return result.rows.map((row) => ({
    name: row.name,
    deployment_id: row.deployment_id,
    project_id: row.project_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

/**
 * Delete a subdomain. Returns true if deleted, false if not found.
 * Checks project ownership if projectId is provided.
 */
export async function deleteSubdomain(name: string, projectId?: string | null): Promise<boolean> {
  if (projectId) {
    const existing = await getSubdomain(name);
    if (!existing) return false;
    if (existing.project_id && existing.project_id !== projectId) {
      // Allow deletion if the owning project is archived/gone (orphaned subdomain)
      const owner = await getProjectById(existing.project_id);
      if (owner && owner.status !== "archived") {
        throw new SubdomainError("Subdomain owned by different project", 403);
      }
    }
  }

  const result = await pool.query(
    sql(`DELETE FROM internal.subdomains WHERE name = $1`),
    [name],
  );

  if (result.rowCount && result.rowCount > 0) {
    cacheInvalidate(name);
    kvsDelete(name);
    // Also delete any linked custom domain
    deleteDomainBySubdomain(name);
    console.log(`  Subdomain released: ${name}`);
    return true;
  }

  return false;
}

/**
 * Delete all subdomains for a project (cleanup on project archive).
 * Best-effort: logs warnings on failures, always cleans up DB.
 */
export async function deleteProjectSubdomains(projectId: string): Promise<void> {
  const result = await pool.query(
    sql(`SELECT name FROM internal.subdomains WHERE project_id = $1`),
    [projectId],
  );

  for (const row of result.rows) {
    try {
      await deleteSubdomain(row.name);
    } catch (err) {
      console.error(`  Warning: failed to delete subdomain ${row.name}:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Resolve a subdomain name to a deployment ID (hot path with caching).
 */
export async function resolveSubdomain(name: string): Promise<string | null> {
  const cached = cacheGet(name);
  if (cached !== undefined) return cached;

  const result = await pool.query(
    sql(`SELECT deployment_id FROM internal.subdomains WHERE name = $1`),
    [name],
  );

  if (result.rows.length === 0) return null;

  const deploymentId = result.rows[0].deployment_id as string;
  cacheSet(name, deploymentId);
  return deploymentId;
}

/**
 * Custom error with HTTP status code.
 */
export class SubdomainError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}
