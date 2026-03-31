/**
 * Custom domains service — map user-owned domains to Run402 subdomains.
 *
 * Manages the internal.domains table and syncs to Cloudflare (Custom Hostnames
 * API for SSL/verification, KV for edge routing).
 */

import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { getSubdomain } from "./subdomains.js";
import {
  cfCustomHostnameCreate,
  cfCustomHostnameDelete,
  cfCustomHostnameGet,
  cfKvPut,
  cfKvDelete,
  cfKvList,
  cfZoneResolve,
  cfWorkerCustomDomainCreate,
  cfWorkerCustomDomainDelete,
} from "./cloudflare.js";

// ---------- Types ----------

export interface DomainRecord {
  domain: string;
  subdomain_name: string;
  project_id: string | null;
  cloudflare_hostname_id: string | null;
  cloudflare_zone_id: string | null;
  status: string;
  dns_instructions: DnsInstructions | null;
  created_at: string;
  updated_at: string;
}

export interface DnsInstructions {
  cname_target: string;
  txt_name?: string;
  txt_value?: string;
}

export class DomainError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}

// ---------- Table init ----------

export async function initDomainsTable(): Promise<void> {
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.domains (
      domain                TEXT PRIMARY KEY,
      subdomain_name        TEXT NOT NULL,
      project_id            TEXT,
      cloudflare_hostname_id TEXT,
      status                TEXT NOT NULL DEFAULT 'pending',
      dns_instructions      JSONB,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));
  await pool.query(sql(`
    CREATE INDEX IF NOT EXISTS idx_domains_subdomain
      ON internal.domains(subdomain_name)
  `));
  await pool.query(sql(`
    CREATE INDEX IF NOT EXISTS idx_domains_project
      ON internal.domains(project_id) WHERE project_id IS NOT NULL
  `));
  await pool.query(sql(`
    ALTER TABLE internal.domains
      ADD COLUMN IF NOT EXISTS cloudflare_zone_id TEXT
  `));
}

// ---------- Validation ----------

const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

export function validateDomain(domain: string): string | null {
  if (typeof domain !== "string") return "Domain must be a string";
  const d = domain.toLowerCase();
  if (d !== domain) return "Domain must be lowercase";
  if (d.length > 253) return "Domain too long (max 253 characters)";
  if (!DOMAIN_RE.test(d)) return "Invalid domain format";
  if (d.endsWith(".run402.com")) return "Cannot use a run402.com subdomain as a custom domain";
  return null;
}

// ---------- CRUD ----------

/**
 * Register a custom domain for a Run402 subdomain.
 */
export async function createDomain(
  domain: string,
  subdomainName: string,
  projectId: string | null,
): Promise<DomainRecord> {
  // Verify subdomain exists
  const subdomain = await getSubdomain(subdomainName);
  if (!subdomain) {
    throw new DomainError("Subdomain not found", 404);
  }

  // Verify project ownership
  if (projectId && subdomain.project_id && subdomain.project_id !== projectId) {
    throw new DomainError("Subdomain owned by another project", 403);
  }

  // Check domain not already registered
  const existing = await getDomain(domain);
  if (existing) {
    throw new DomainError("Domain already registered", 409);
  }

  // Register with Cloudflare Custom Hostnames
  let hostnameId: string | null = null;
  let dnsInstructions: DnsInstructions | null = null;
  try {
    const cfResult = await cfCustomHostnameCreate(domain);
    if (cfResult) {
      hostnameId = cfResult.id;
      dnsInstructions = cfResult.dns_instructions;
    }
  } catch (err) {
    console.error(
      `Cloudflare custom hostname creation failed (${domain}):`,
      err instanceof Error ? err.message : err,
    );
    // Continue — domain is registered in DB as pending, Cloudflare sync will retry via reconciliation
  }

  // Write to Cloudflare KV (domain → deployment_id)
  cfKvPut(domain, subdomain.deployment_id);

  // Resolve zone and create Worker Custom Domain binding
  let zoneId: string | null = null;
  try {
    zoneId = await cfZoneResolve(domain);
    if (zoneId) {
      cfWorkerCustomDomainCreate(domain, zoneId);
    } else {
      console.warn(`CF zone not found for ${domain} — Worker Custom Domain binding skipped`);
    }
  } catch (err) {
    console.error(
      `CF zone resolve failed (${domain}):`,
      err instanceof Error ? err.message : err,
    );
  }

  // Insert DB record
  const result = await pool.query(
    sql(`INSERT INTO internal.domains (domain, subdomain_name, project_id, cloudflare_hostname_id, cloudflare_zone_id, status, dns_instructions)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING domain, subdomain_name, project_id, cloudflare_hostname_id, cloudflare_zone_id, status, dns_instructions, created_at, updated_at`),
    [domain, subdomainName, projectId || null, hostnameId, zoneId, "pending", dnsInstructions ? JSON.stringify(dnsInstructions) : null],
  );

  const row = result.rows[0];
  console.log(`  Custom domain registered: ${domain} → ${subdomainName}`);
  return rowToRecord(row);
}

/**
 * Get a domain record, optionally refreshing status from Cloudflare.
 */
export async function getDomain(domain: string): Promise<DomainRecord | null> {
  const result = await pool.query(
    sql(`SELECT domain, subdomain_name, project_id, cloudflare_hostname_id, cloudflare_zone_id, status, dns_instructions, created_at, updated_at
     FROM internal.domains WHERE domain = $1`),
    [domain],
  );
  if (result.rows.length === 0) return null;
  return rowToRecord(result.rows[0]);
}

/**
 * Get a domain record with live status from Cloudflare.
 */
export async function getDomainWithStatus(domain: string): Promise<DomainRecord | null> {
  const record = await getDomain(domain);
  if (!record) return null;

  // If we have a Cloudflare hostname ID and status isn't yet active, check live status
  if (record.cloudflare_hostname_id && record.status !== "active") {
    try {
      const cfStatus = await cfCustomHostnameGet(record.cloudflare_hostname_id);
      if (cfStatus && cfStatus.status !== record.status) {
        await pool.query(
          sql(`UPDATE internal.domains SET status = $1, updated_at = NOW() WHERE domain = $2`),
          [cfStatus.status, domain],
        );
        record.status = cfStatus.status;
      }
    } catch (err) {
      console.error(
        `Cloudflare status check failed (${domain}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return record;
}

/**
 * List domains for a project, or all domains (admin).
 */
export async function listDomains(projectId?: string | null): Promise<DomainRecord[]> {
  const result = projectId
    ? await pool.query(
        sql(`SELECT domain, subdomain_name, project_id, cloudflare_hostname_id, cloudflare_zone_id, status, dns_instructions, created_at, updated_at
         FROM internal.domains WHERE project_id = $1 ORDER BY created_at DESC`),
        [projectId],
      )
    : await pool.query(
        sql(`SELECT domain, subdomain_name, project_id, cloudflare_hostname_id, cloudflare_zone_id, status, dns_instructions, created_at, updated_at
         FROM internal.domains ORDER BY created_at DESC`),
      );

  return result.rows.map(rowToRecord);
}

/**
 * Delete a custom domain. Returns true if deleted, false if not found.
 */
export async function deleteDomain(domain: string, projectId?: string | null): Promise<boolean> {
  const record = await getDomain(domain);
  if (!record) return false;

  // Check project ownership
  if (projectId && record.project_id && record.project_id !== projectId) {
    throw new DomainError("Domain owned by another project", 403);
  }

  // Remove from Cloudflare Custom Hostnames
  if (record.cloudflare_hostname_id) {
    try {
      await cfCustomHostnameDelete(record.cloudflare_hostname_id);
    } catch (err) {
      console.error(
        `Cloudflare custom hostname deletion failed (${domain}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Remove Worker Custom Domain binding
  if (record.cloudflare_zone_id) {
    cfWorkerCustomDomainDelete(domain);
  }

  // Remove from Cloudflare KV
  cfKvDelete(domain);

  // Delete DB record
  const result = await pool.query(
    sql(`DELETE FROM internal.domains WHERE domain = $1`),
    [domain],
  );

  if (result.rowCount && result.rowCount > 0) {
    console.log(`  Custom domain released: ${domain}`);
    return true;
  }

  return false;
}

/**
 * Get the custom domain linked to a subdomain name, if any.
 */
export async function getDomainBySubdomain(subdomainName: string): Promise<DomainRecord | null> {
  const result = await pool.query(
    sql(`SELECT domain, subdomain_name, project_id, cloudflare_hostname_id, cloudflare_zone_id, status, dns_instructions, created_at, updated_at
     FROM internal.domains WHERE subdomain_name = $1`),
    [subdomainName],
  );
  if (result.rows.length === 0) return null;
  return rowToRecord(result.rows[0]);
}

/**
 * Update the Cloudflare KV entry for a custom domain with a new deployment_id.
 * Called when the linked subdomain is redeployed.
 * Fire-and-forget: logs errors but does not throw.
 */
export async function updateDomainDeployment(subdomainName: string, deploymentId: string): Promise<void> {
  const domainRecord = await getDomainBySubdomain(subdomainName);
  if (!domainRecord) return;

  cfKvPut(domainRecord.domain, deploymentId);
  console.log(`  Custom domain KV updated: ${domainRecord.domain} → ${deploymentId}`);
}

/**
 * Delete all custom domains linked to a subdomain.
 * Called when the subdomain is released.
 */
export async function deleteDomainBySubdomain(subdomainName: string): Promise<void> {
  const domainRecord = await getDomainBySubdomain(subdomainName);
  if (!domainRecord) return;
  try {
    await deleteDomain(domainRecord.domain);
  } catch (err) {
    console.error(
      `Warning: failed to delete custom domain ${domainRecord.domain}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------- Reconciliation ----------

/**
 * Reconcile Cloudflare KV with the domains table.
 * Same pattern as kvsReconcile() for CloudFront KVS.
 */
export async function cfKvReconcile(): Promise<void> {
  try {
    // 1. Load all DB domains → resolve to deployment_id via linked subdomain
    const dbResult = await pool.query(
      sql(`SELECT d.domain, s.deployment_id
       FROM internal.domains d
       JOIN internal.subdomains s ON d.subdomain_name = s.name`),
    );
    const dbMap = new Map<string, string>();
    for (const row of dbResult.rows) {
      dbMap.set(row.domain as string, row.deployment_id as string);
    }

    // 2. Load all Cloudflare KV entries
    const kvEntries = await cfKvList();
    const kvMap = new Map<string, string>();
    for (const entry of kvEntries) {
      kvMap.set(entry.key, entry.value);
    }

    let added = 0;
    let updated = 0;
    let removed = 0;

    // 3. Add missing / update stale
    for (const [domain, deploymentId] of dbMap) {
      const kvValue = kvMap.get(domain);
      if (!kvValue) {
        cfKvPut(domain, deploymentId);
        added++;
      } else if (kvValue !== deploymentId) {
        cfKvPut(domain, deploymentId);
        updated++;
      }
    }

    // 4. Remove orphaned
    for (const [domain] of kvMap) {
      if (!dbMap.has(domain)) {
        cfKvDelete(domain);
        removed++;
      }
    }

    const total = added + updated + removed;
    if (total > 0) {
      console.log(
        `CF KV reconciliation: ${added} added, ${updated} updated, ${removed} removed`,
      );
    }
  } catch (err) {
    console.error(
      "CF KV reconciliation failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------- Periodic reconciliation ----------

const CF_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
let cfReconcileTimer: ReturnType<typeof setInterval> | null = null;

export function startCfKvReconciliation(): void {
  if (cfReconcileTimer) return;

  const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
  if (!CLOUDFLARE_API_TOKEN) return;

  setTimeout(() => cfKvReconcile(), 15_000);
  cfReconcileTimer = setInterval(() => cfKvReconcile(), CF_RECONCILE_INTERVAL_MS);
  console.log("CF KV reconciliation started (every 5 minutes)");
}

// ---------- Helpers ----------

function rowToRecord(row: Record<string, unknown>): DomainRecord {
  return {
    domain: row.domain as string,
    subdomain_name: row.subdomain_name as string,
    project_id: row.project_id as string | null,
    cloudflare_hostname_id: row.cloudflare_hostname_id as string | null,
    cloudflare_zone_id: row.cloudflare_zone_id as string | null,
    status: row.status as string,
    dns_instructions: row.dns_instructions as DnsInstructions | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}
