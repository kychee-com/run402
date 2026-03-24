/**
 * Bundle deploy service — deploy to an existing project.
 *
 * Orchestrates: migrations → RLS → secrets → functions → site → subdomain.
 * Requires project_id — never creates projects (use POST /projects/v1 first).
 */

import { getProjectById, deriveProjectKeys } from "./projects.js";
import { deployFunction, setSecret } from "./functions.js";
import { createDeployment } from "./deployments.js";
import { createOrUpdateSubdomain, validateSubdomainName } from "./subdomains.js";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { TIERS } from "@run402/shared";
import type { ProjectInfo } from "@run402/shared";

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
  project_id: string;
  migrations?: string;
  rls?: { template: string; tables: RlsTable[] };
  secrets?: BundleSecret[];
  functions?: BundleFunction[];
  files?: BundleFile[];
  subdomain?: string;
}

export interface BundleResult {
  project_id: string;
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
  if (!req.project_id || typeof req.project_id !== "string") {
    throw new BundleError("Missing or invalid 'project_id' field", 400);
  }
  if (!/^prj_\d+_\d+$/.test(req.project_id)) {
    throw new BundleError("Invalid project_id format (expected prj_<timestamp>_<slot>)", 400);
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
 * Execute a bundle deploy — deploys to an existing project.
 * Requires project_id; never creates projects.
 */
export async function deployBundle(
  req: BundleRequest,
  apiBase: string,
  walletAddress?: string,
): Promise<BundleResult> {
  // 1. Look up existing project
  const project = await getProjectById(req.project_id);
  if (!project) {
    throw new BundleError(`Project not found: ${req.project_id}`, 404);
  }
  if (project.status !== "active") {
    throw new BundleError(`Project ${req.project_id} is not active (status: ${project.status})`, 400);
  }
  if (walletAddress && project.walletAddress &&
      walletAddress.toLowerCase() !== project.walletAddress.toLowerCase()) {
    throw new BundleError("Wallet does not own this project", 403);
  }

  const tier = project.tier;
  const tierConfig = TIERS[tier];
  const { serviceKey } = deriveProjectKeys(project.id, tier);

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
        serviceKey,
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
      { project: project.id, files: req.files },
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
  };

  if (siteUrl) result.site_url = siteUrl;
  if (deploymentId) result.deployment_id = deploymentId;
  if (deployedFunctions.length > 0) result.functions = deployedFunctions;
  if (req.subdomain) result.subdomain_url = `https://${req.subdomain}.run402.com`;

  console.log(`  Bundle deployed: ${project.id} (${tier}) — ${deployedFunctions.length} functions, ${req.files?.length || 0} site files`);

  return result;
}

/**
 * Run SQL migrations within a project's schema.
 */
async function runMigrations(project: ProjectInfo, migrationSql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(sql("BEGIN"));
    await client.query(sql(`SET search_path TO ${project.schemaSlot}`));
    await client.query(sql(migrationSql));
    await client.query(sql("NOTIFY pgrst, 'reload schema'"));
    await client.query(sql("COMMIT"));
    console.log(`  Migrations applied to ${project.id} (${project.schemaSlot})`);
  } catch (err) {
    await client.query(sql("ROLLBACK")).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    throw new BundleError(`Migration SQL error: ${msg}`, 422);
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
    await client.query(sql("BEGIN"));
    await client.query(sql(`SET search_path TO ${project.schemaSlot}`));

    for (const table of tables) {
      const tableName = table.table;

      // Drop existing policies for idempotent redeploy
      const existing = await client.query(
        sql(`SELECT policyname FROM pg_policies WHERE schemaname = $1 AND tablename = $2`),
        [project.schemaSlot, tableName],
      );
      for (const row of existing.rows) {
        await client.query(sql(`DROP POLICY ${JSON.stringify(row.policyname)} ON ${tableName}`));
      }

      await client.query(sql(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`));
      await client.query(sql(`ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY`));

      if (template === "user_owns_rows") {
        const col = table.owner_column!;
        await client.query(sql(`CREATE POLICY "Users can view own rows" ON ${tableName} FOR SELECT USING (${col}::text = auth.uid()::text)`));
        await client.query(sql(`CREATE POLICY "Users can insert own rows" ON ${tableName} FOR INSERT WITH CHECK (${col}::text = auth.uid()::text)`));
        await client.query(sql(`CREATE POLICY "Users can update own rows" ON ${tableName} FOR UPDATE USING (${col}::text = auth.uid()::text)`));
        await client.query(sql(`CREATE POLICY "Users can delete own rows" ON ${tableName} FOR DELETE USING (${col}::text = auth.uid()::text)`));
      } else if (template === "public_read") {
        await client.query(sql(`CREATE POLICY "Anyone can read" ON ${tableName} FOR SELECT USING (true)`));
        await client.query(sql(`CREATE POLICY "Authenticated users can insert" ON ${tableName} FOR INSERT WITH CHECK (auth.role() = 'authenticated')`));
        await client.query(sql(`CREATE POLICY "Authenticated users can update" ON ${tableName} FOR UPDATE USING (auth.role() = 'authenticated')`));
        await client.query(sql(`CREATE POLICY "Authenticated users can delete" ON ${tableName} FOR DELETE USING (auth.role() = 'authenticated')`));
      } else if (template === "public_read_write") {
        await client.query(sql(`GRANT INSERT, UPDATE, DELETE ON ${tableName} TO anon`));
        await client.query(sql(`CREATE POLICY "Anyone can read" ON ${tableName} FOR SELECT USING (true)`));
        await client.query(sql(`CREATE POLICY "Anyone can insert" ON ${tableName} FOR INSERT WITH CHECK (true)`));
        await client.query(sql(`CREATE POLICY "Anyone can update" ON ${tableName} FOR UPDATE USING (true)`));
        await client.query(sql(`CREATE POLICY "Anyone can delete" ON ${tableName} FOR DELETE USING (true)`));
      }
    }

    await client.query(sql("COMMIT"));
    console.log(`  RLS (${template}) applied to ${project.id}: ${tables.map((t) => t.table).join(", ")}`);
  } catch (err) {
    await client.query(sql("ROLLBACK"));
    throw err;
  } finally {
    client.release();
  }
}
