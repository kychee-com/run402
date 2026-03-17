/**
 * Bundle deploy service — atomic one-call deploy of a full app.
 *
 * Orchestrates: project creation → migrations → RLS → secrets → functions → site → subdomain.
 * If any step fails after project creation, the project is archived to clean up.
 */

import { createProject, archiveProject } from "./projects.js";
import { deployFunction, setSecret } from "./functions.js";
import { createDeployment } from "./deployments.js";
import { createOrUpdateSubdomain, validateSubdomainName } from "./subdomains.js";
import { pool } from "../db/pool.js";
import { TIERS } from "@run402/shared";
import type { TierName, ProjectInfo } from "@run402/shared";

export interface BundleFunction {
  name: string;
  code: string;
  config?: { timeout?: number; memory?: number };
}

export interface BundleFile {
  file: string;
  data: string;
  encoding?: "utf-8" | "base64";
}

export interface BundleSecret {
  key: string;
  value: string;
}

export interface RlsTable {
  table: string;
  owner_column?: string;
}

export interface BundleRequest {
  name: string;
  tier?: TierName;
  migrations?: string;
  rls?: { template: string; tables: RlsTable[] };
  secrets?: BundleSecret[];
  functions?: BundleFunction[];
  files?: BundleFile[];
  subdomain?: string;
}

export interface BundleResult {
  project_id: string;
  anon_key: string;
  service_key: string;
  schema_slot: string;
  site_url?: string;
  deployment_id?: string;
  functions?: Array<{ name: string; url: string }>;
  subdomain_url?: string;
}

export class BundleError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}

// SQL blocklist — same as admin routes
const BLOCKED_PATTERNS = [
  /\bCREATE\s+EXTENSION\b/i,
  /\bCOPY\b.*\bPROGRAM\b/i,
  /\bALTER\s+SYSTEM\b/i,
  /\bSET\s+(search_path|role)\b/i,
  /\bCREATE\s+SCHEMA\b/i,
  /\bDROP\s+SCHEMA\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bCREATE\s+ROLE\b/i,
  /\bDROP\s+ROLE\b/i,
];

const VALID_RLS_TEMPLATES = ["user_owns_rows", "public_read", "public_read_write"];

/**
 * Validate a bundle request. Throws BundleError on invalid input.
 */
export function validateBundle(req: BundleRequest): void {
  if (!req.name || typeof req.name !== "string") {
    throw new BundleError("Missing or invalid 'name' field", 400);
  }

  if (req.tier && !TIERS[req.tier]) {
    throw new BundleError(
      `Unknown tier: ${req.tier}. Valid tiers: ${Object.keys(TIERS).join(", ")}`,
      400,
    );
  }

  if (req.migrations !== undefined) {
    if (typeof req.migrations !== "string") {
      throw new BundleError("'migrations' must be a SQL string", 400);
    }
    if (req.migrations.length > 1_000_000) {
      throw new BundleError("'migrations' exceeds 1MB limit", 400);
    }
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(req.migrations)) {
        throw new BundleError(`Blocked SQL pattern in migrations: ${pattern.source}`, 403);
      }
    }
  }

  if (req.rls !== undefined) {
    if (!req.rls.template || !Array.isArray(req.rls.tables)) {
      throw new BundleError("'rls' requires 'template' and 'tables' array", 400);
    }
    if (!VALID_RLS_TEMPLATES.includes(req.rls.template)) {
      throw new BundleError(
        `Invalid RLS template. Valid: ${VALID_RLS_TEMPLATES.join(", ")}`,
        400,
      );
    }
    if (req.rls.template === "user_owns_rows") {
      for (const t of req.rls.tables) {
        if (!t.owner_column) {
          throw new BundleError(
            `owner_column required for table '${t.table}' with user_owns_rows template`,
            400,
          );
        }
      }
    }
  }

  if (req.secrets !== undefined) {
    if (!Array.isArray(req.secrets)) {
      throw new BundleError("'secrets' must be an array", 400);
    }
    for (const s of req.secrets) {
      if (!s.key || typeof s.key !== "string") {
        throw new BundleError("Each secret must have a 'key' field", 400);
      }
      if (s.value === undefined || typeof s.value !== "string") {
        throw new BundleError(`Secret '${s.key}' is missing 'value'`, 400);
      }
      if (!/^[A-Z_][A-Z0-9_]{0,62}$/.test(s.key)) {
        throw new BundleError(
          `Secret key '${s.key}' must be uppercase alphanumeric + underscores`,
          400,
        );
      }
    }
  }

  if (req.functions !== undefined) {
    if (!Array.isArray(req.functions)) {
      throw new BundleError("'functions' must be an array", 400);
    }
    const nameRe = /^[a-z0-9][a-z0-9-]{0,62}$/;
    for (const fn of req.functions) {
      if (!fn.name || typeof fn.name !== "string") {
        throw new BundleError("Each function must have a 'name' field", 400);
      }
      if (!nameRe.test(fn.name)) {
        throw new BundleError(
          `Function name '${fn.name}' must be lowercase alphanumeric + hyphens`,
          400,
        );
      }
      if (!fn.code || typeof fn.code !== "string") {
        throw new BundleError(`Function '${fn.name}' is missing 'code'`, 400);
      }
    }
  }

  if (req.files !== undefined) {
    if (!Array.isArray(req.files) || req.files.length === 0) {
      throw new BundleError("'files' must be a non-empty array of files", 400);
    }
    for (const f of req.files) {
      if (!f.file || typeof f.file !== "string") {
        throw new BundleError("Each site file must have a 'file' (path) field", 400);
      }
      if (f.data === undefined || f.data === null) {
        throw new BundleError(`Site file '${f.file}' is missing 'data'`, 400);
      }
      if (f.encoding && f.encoding !== "utf-8" && f.encoding !== "base64") {
        throw new BundleError(
          `Site file '${f.file}' has invalid encoding (must be 'utf-8' or 'base64')`,
          400,
        );
      }
    }
  }

  if (req.subdomain !== undefined) {
    if (typeof req.subdomain !== "string") {
      throw new BundleError("'subdomain' must be a string", 400);
    }
    const subError = validateSubdomainName(req.subdomain);
    if (subError) {
      throw new BundleError(subError, 400);
    }
  }
}

/**
 * Execute a bundle deploy — creates project and deploys everything atomically.
 * On failure after project creation, archives the project to clean up.
 */
export async function deployBundle(
  req: BundleRequest,
  apiBase: string,
  txHash?: string,
  walletAddress?: string,
): Promise<BundleResult> {
  const tier = req.tier || "prototype";
  const tierConfig = TIERS[tier];

  // 1. Create project
  const project = await createProject(req.name, tier, txHash, walletAddress);
  if (!project) {
    throw new BundleError("No schema slots available", 503);
  }

  try {
    // 2. Run migrations
    if (req.migrations) {
      await runMigrations(project, req.migrations);
    }

    // 3. Apply RLS
    if (req.rls) {
      await applyRls(project, req.rls.template, req.rls.tables);
    }

    // 4. Set secrets
    if (req.secrets) {
      for (const s of req.secrets) {
        await setSecret(project.id, s.key, s.value, tierConfig);
      }
    }

    // 5. Deploy functions
    const deployedFunctions: Array<{ name: string; url: string }> = [];
    if (req.functions) {
      for (const fn of req.functions) {
        const result = await deployFunction(
          project.id,
          fn.name,
          fn.code,
          project.serviceKey,
          apiBase,
          fn.config,
          undefined,
          tierConfig,
        );
        deployedFunctions.push({ name: result.name, url: result.url });
      }
    }

    // 6. Deploy site
    let siteUrl: string | undefined;
    let deploymentId: string | undefined;
    if (req.files) {
      const deployment = await createDeployment(
        { name: req.name, project: project.id, files: req.files },
        txHash,
      );
      siteUrl = deployment.url;
      deploymentId = deployment.deployment_id;

      // 7. Claim subdomain — pass wallet so same-wallet redeploys can reassign
      if (req.subdomain && deploymentId) {
        await createOrUpdateSubdomain(req.subdomain, deploymentId, project.id, walletAddress);
        siteUrl = `https://${req.subdomain}.run402.com`;
      }
    }

    const result: BundleResult = {
      project_id: project.id,
      anon_key: project.anonKey,
      service_key: project.serviceKey,
      schema_slot: project.schemaSlot,
    };

    if (siteUrl) result.site_url = siteUrl;
    if (deploymentId) result.deployment_id = deploymentId;
    if (deployedFunctions.length > 0) result.functions = deployedFunctions;
    if (req.subdomain) result.subdomain_url = `https://${req.subdomain}.run402.com`;

    console.log(`  Bundle deployed: ${project.id} (${tier}) — ${deployedFunctions.length} functions, ${req.files?.length || 0} site files`);

    return result;
  } catch (err) {
    // Rollback: archive the project on failure
    console.error(`  Bundle deploy failed for ${project.id}, archiving...`);
    try {
      await archiveProject(project.id);
    } catch (archiveErr) {
      console.error(`  Failed to archive project ${project.id} during rollback`);
    }
    throw err;
  }
}

/**
 * Run SQL migrations within a project's schema.
 */
async function runMigrations(project: ProjectInfo, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET search_path TO ${project.schemaSlot}`);
    await client.query(sql);
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query("COMMIT");
    console.log(`  Migrations applied to ${project.id} (${project.schemaSlot})`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Migration SQL error: ${msg}`);
  } finally {
    client.release();
  }
}

/**
 * Apply RLS template to tables within a project's schema.
 */
async function applyRls(
  project: ProjectInfo,
  template: string,
  tables: RlsTable[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET search_path TO ${project.schemaSlot}`);

    for (const table of tables) {
      const tableName = table.table;
      await client.query(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY`);

      if (template === "user_owns_rows") {
        const col = table.owner_column!;
        await client.query(`CREATE POLICY "Users can view own rows" ON ${tableName} FOR SELECT USING (${col} = auth.uid())`);
        await client.query(`CREATE POLICY "Users can insert own rows" ON ${tableName} FOR INSERT WITH CHECK (${col} = auth.uid())`);
        await client.query(`CREATE POLICY "Users can update own rows" ON ${tableName} FOR UPDATE USING (${col} = auth.uid())`);
        await client.query(`CREATE POLICY "Users can delete own rows" ON ${tableName} FOR DELETE USING (${col} = auth.uid())`);
      } else if (template === "public_read") {
        await client.query(`CREATE POLICY "Anyone can read" ON ${tableName} FOR SELECT USING (true)`);
        await client.query(`CREATE POLICY "Authenticated users can insert" ON ${tableName} FOR INSERT WITH CHECK (auth.role() = 'authenticated')`);
        await client.query(`CREATE POLICY "Authenticated users can update" ON ${tableName} FOR UPDATE USING (auth.role() = 'authenticated')`);
        await client.query(`CREATE POLICY "Authenticated users can delete" ON ${tableName} FOR DELETE USING (auth.role() = 'authenticated')`);
      } else if (template === "public_read_write") {
        await client.query(`GRANT INSERT, UPDATE, DELETE ON ${tableName} TO anon`);
        await client.query(`CREATE POLICY "Anyone can read" ON ${tableName} FOR SELECT USING (true)`);
        await client.query(`CREATE POLICY "Anyone can insert" ON ${tableName} FOR INSERT WITH CHECK (true)`);
        await client.query(`CREATE POLICY "Anyone can update" ON ${tableName} FOR UPDATE USING (true)`);
        await client.query(`CREATE POLICY "Anyone can delete" ON ${tableName} FOR DELETE USING (true)`);
      }
    }

    await client.query("COMMIT");
    console.log(`  RLS (${template}) applied to ${project.id}: ${tables.map((t) => t.table).join(", ")}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
