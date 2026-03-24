import { Router, Request, Response, NextFunction } from "express";
import { pool } from "../db/pool.js";
import { serviceKeyAuth } from "../middleware/apikey.js";
import { demoBlockedMiddleware } from "../middleware/demo.js";
import { getTierLimits } from "@run402/shared";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import { ADMIN_KEY } from "../config.js";
import { isAdminWallet } from "../services/admin-wallets.js";
import { getProjectById } from "../services/projects.js";
import { parseSIWxHeader, verifySIWxSignature } from "@x402/extensions/sign-in-with-x";

interface RlsTable {
  table: string;
  owner_column?: string;
}

interface PgColumn {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

interface PgConstraint {
  constraint_name: string;
  constraint_type: string;
  definition: string;
}

interface PgPolicy {
  name: string;
  command: string;
  using_expression: string | null;
  check_expression: string | null;
}

const router = Router();

/**
 * Check if the request has a valid admin key header.
 */
function hasAdminKey(req: Request): boolean {
  const adminKey = req.headers["x-admin-key"] as string | undefined;
  return !!(ADMIN_KEY && adminKey === ADMIN_KEY);
}

/**
 * Try to authenticate via SIWX and check if the wallet is an admin wallet.
 * Returns the normalized wallet address if valid, null otherwise.
 */
async function tryAdminSiwx(req: Request): Promise<string | null> {
  const siwxHeader = req.headers["sign-in-with-x"] as string | undefined;
  if (!siwxHeader) return null;

  try {
    const payload = parseSIWxHeader(siwxHeader);

    // Validate expiration
    if (payload.expirationTime) {
      const expiry = new Date(payload.expirationTime);
      if (expiry.getTime() < Date.now()) return null;
    }

    // Validate issuedAt (5 min max age)
    if (payload.issuedAt) {
      const issued = new Date(payload.issuedAt);
      if (Date.now() - issued.getTime() > 5 * 60 * 1000) return null;
    }

    // Validate domain
    if (payload.domain && payload.domain !== req.hostname) return null;

    const verification = await verifySIWxSignature(payload);
    if (!verification.valid || !verification.address) return null;

    const normalized = verification.address.toLowerCase();
    return isAdminWallet(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * Require admin privileges: either x-admin-key header or SIWX with an admin wallet.
 */
function requireAdmin(req: Request): Promise<void> | void {
  // Fast path: admin key
  if (hasAdminKey(req)) return;

  // Async path: SIWX admin wallet
  return (async () => {
    const wallet = await tryAdminSiwx(req);
    if (!wallet) {
      throw new HttpError(403, "Admin access required", { admin_required: true, message: "Requires platform admin key or SIWX auth from an admin wallet" });
    }
    req.walletAddress = wallet;
  })();
}

// POST /projects/v1/admin/:id/wallet — set project wallet address (admin only, no service key)
router.post("/projects/v1/admin/:id/wallet", asyncHandler(async (req: Request, res: Response) => {
  await requireAdmin(req);

  const projectId = req.params.id as string;
  const { wallet_address } = req.body || {};

  if (!wallet_address || typeof wallet_address !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(wallet_address)) {
    throw new HttpError(400, "Invalid wallet_address (must be 0x + 40 hex chars)");
  }

  const result = await pool.query(
    `UPDATE internal.projects SET wallet_address = $1 WHERE id = $2 AND status = 'active' RETURNING id`,
    [wallet_address, projectId],
  );
  if (result.rowCount === 0) {
    throw new HttpError(404, "Project not found or not active");
  }

  console.log(`  Project ${projectId} wallet set to ${wallet_address}`);
  res.json({ status: "ok", project_id: projectId, wallet_address });
}));

/**
 * Admin routes auth: accept service_key (existing flow) OR SIWX with admin wallet.
 * Admin wallets bypass service_key — they can operate on any project.
 */
async function adminOrServiceKeyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Try SIWX admin wallet first (skips service_key requirement)
  const wallet = await tryAdminSiwx(req);
  if (wallet) {
    req.walletAddress = wallet;
    // Load project into req.project for downstream handlers.
    // req.params.id is not available here (middleware runs before route matching),
    // so extract the project ID from the URL path directly.
    const match = req.originalUrl.match(/\/projects\/v1\/admin\/(prj_[^/]+)/);
    const projectId = match?.[1];
    if (projectId) {
      const project = await getProjectById(projectId);
      if (!project || project.status !== "active") {
        res.status(404).json({ error: "Project not found or not active" });
        return;
      }
      req.project = project;
    }
    next();
    return;
  }

  // Fall back to existing service_key auth
  serviceKeyAuth(req, res, next);
}

router.use("/projects/v1/admin", adminOrServiceKeyAuth);

// SQL statement blocklist — defense-in-depth (real boundary is search_path + pre_request hook)
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; hint?: string }> = [
  { pattern: /\bCREATE\s+EXTENSION\b/i },
  { pattern: /\bCOPY\b.*\bPROGRAM\b/i },
  { pattern: /\bALTER\s+SYSTEM\b/i },
  { pattern: /\bSET\s+(search_path|role)\b/i },
  { pattern: /\bCREATE\s+SCHEMA\b/i },
  { pattern: /\bDROP\s+SCHEMA\b/i },
  {
    pattern: /\bGRANT\b/i,
    hint: "Permissions are managed automatically. For SERIAL/BIGSERIAL columns, sequence permissions are pre-granted. Prefer BIGINT GENERATED ALWAYS AS IDENTITY over SERIAL for new tables.",
  },
  {
    pattern: /\bREVOKE\b/i,
    hint: "Permissions are managed automatically. Use RLS policies (POST /projects/v1/admin/:id/rls) to control row-level access.",
  },
  { pattern: /\bCREATE\s+ROLE\b/i },
  { pattern: /\bDROP\s+ROLE\b/i },
];

function checkSqlSafety(sql: string): { error: string; hint?: string } | null {
  for (const { pattern, hint } of BLOCKED_PATTERNS) {
    if (pattern.test(sql)) {
      return {
        error: `Blocked SQL pattern: ${pattern.source}`,
        hint,
      };
    }
  }
  return null;
}

/** Verify service_key matches the project in the URL. */
function assertProjectMatch(req: Request): void {
  if (!req.project) {
    throw new HttpError(401, "Project authentication required");
  }
  if (req.project.id !== req.params["id"]) {
    throw new HttpError(403, "Token project_id mismatch");
  }
}

// POST /projects/v1/admin/:id/sql — run SQL migration (blocked in demo mode)
router.post("/projects/v1/admin/:id/sql", demoBlockedMiddleware("SQL execution"), asyncHandler(async (req: Request, res: Response) => {
  assertProjectMatch(req);
  const project = req.project!;

  let sql: string | undefined;
  const contentType = req.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(req.body as string) as Record<string, unknown>;
    const val = parsed["sql"] ?? parsed["query"];
    sql = typeof val === "string" ? val : undefined;
  } else {
    sql = typeof req.body === "string" ? req.body : undefined;
  }
  if (!sql) {
    throw new HttpError(400, "No SQL provided — send raw SQL as text/plain body, or JSON with a \"sql\" field");
  }

  // Check SQL safety
  const blocked = checkSqlSafety(sql);
  if (blocked) {
    throw new HttpError(403, blocked.hint ? `${blocked.error} — ${blocked.hint}` : blocked.error);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET search_path TO ${project.schemaSlot}`);
    const result = await client.query(sql);
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query("COMMIT");

    console.log(`  Migration applied to ${project.id} (${project.schemaSlot})`);

    // Multi-statement SQL returns an array of results; single-statement returns one result
    const last = Array.isArray(result) ? result[result.length - 1] : result;
    res.json({
      status: "ok",
      schema: project.schemaSlot,
      rows: last?.rows ?? [],
      rowCount: Array.isArray(result)
        ? result.reduce((n, r) => n + (r.rowCount ?? 0), 0)
        : result.rowCount,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(400, `SQL error: ${msg}`);
  } finally {
    client.release();
  }
}));

// POST /projects/v1/admin/:id/rls — apply RLS template
router.post("/projects/v1/admin/:id/rls", asyncHandler(async (req: Request, res: Response) => {
  assertProjectMatch(req);
  const project = req.project!;

  const { template, tables } = req.body || {};
  const VALID_TEMPLATES = ["user_owns_rows", "public_read", "public_read_write"];
  if (!VALID_TEMPLATES.includes(template) || !Array.isArray(tables)) {
    throw new HttpError(400, `Requires template (${VALID_TEMPLATES.join(", ")}) and tables array`);
  }

  // user_owns_rows requires owner_column on every table
  if (template === "user_owns_rows") {
    for (const t of tables) {
      if (!t.owner_column) {
        throw new HttpError(400, `owner_column required for table '${t.table}' with user_owns_rows template`);
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET search_path TO ${project.schemaSlot}`);

    for (const table of tables) {
      const tableName = table.table;

      await client.query(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY`);

      if (template === "user_owns_rows") {
        const ownerColumn = table.owner_column;
        await client.query(`
          CREATE POLICY "Users can view own rows" ON ${tableName}
            FOR SELECT USING (${ownerColumn}::text = auth.uid()::text)
        `);
        await client.query(`
          CREATE POLICY "Users can insert own rows" ON ${tableName}
            FOR INSERT WITH CHECK (${ownerColumn}::text = auth.uid()::text)
        `);
        await client.query(`
          CREATE POLICY "Users can update own rows" ON ${tableName}
            FOR UPDATE USING (${ownerColumn}::text = auth.uid()::text)
        `);
        await client.query(`
          CREATE POLICY "Users can delete own rows" ON ${tableName}
            FOR DELETE USING (${ownerColumn}::text = auth.uid()::text)
        `);
      } else if (template === "public_read") {
        await client.query(`
          CREATE POLICY "Anyone can read" ON ${tableName}
            FOR SELECT USING (true)
        `);
        await client.query(`
          CREATE POLICY "Authenticated users can insert" ON ${tableName}
            FOR INSERT WITH CHECK (auth.role() = 'authenticated')
        `);
        await client.query(`
          CREATE POLICY "Authenticated users can update" ON ${tableName}
            FOR UPDATE USING (auth.role() = 'authenticated')
        `);
        await client.query(`
          CREATE POLICY "Authenticated users can delete" ON ${tableName}
            FOR DELETE USING (auth.role() = 'authenticated')
        `);
      } else if (template === "public_read_write") {
        await client.query(`GRANT INSERT, UPDATE, DELETE ON ${tableName} TO anon`);
        await client.query(`
          CREATE POLICY "Anyone can read" ON ${tableName}
            FOR SELECT USING (true)
        `);
        await client.query(`
          CREATE POLICY "Anyone can insert" ON ${tableName}
            FOR INSERT WITH CHECK (true)
        `);
        await client.query(`
          CREATE POLICY "Anyone can update" ON ${tableName}
            FOR UPDATE USING (true)
        `);
        await client.query(`
          CREATE POLICY "Anyone can delete" ON ${tableName}
            FOR DELETE USING (true)
        `);
      }
    }

    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log(`  RLS (${template}) applied to ${project.id}: ${(tables as RlsTable[]).map((t) => t.table).join(", ")}`);
  res.json({ status: "ok", template, tables: (tables as RlsTable[]).map((t) => t.table) });
}));

// POST /projects/v1/admin/:id/pin — pin project (lease never expires, admin only)
router.post("/projects/v1/admin/:id/pin", asyncHandler(async (req: Request, res: Response) => {
  await requireAdmin(req);

  assertProjectMatch(req);
  const project = req.project!;

  await pool.query(`UPDATE internal.projects SET pinned = true WHERE id = $1`, [project.id]);
  project.pinned = true;

  console.log(`  Project ${project.id} pinned (lease will not expire)`);
  res.json({ status: "ok", project_id: project.id, pinned: true });
}));

// POST /projects/v1/admin/:id/unpin — unpin project (normal lease expiry resumes, admin only)
router.post("/projects/v1/admin/:id/unpin", asyncHandler(async (req: Request, res: Response) => {
  await requireAdmin(req);

  assertProjectMatch(req);
  const project = req.project!;

  await pool.query(`UPDATE internal.projects SET pinned = false WHERE id = $1`, [project.id]);
  project.pinned = false;

  console.log(`  Project ${project.id} unpinned`);
  res.json({ status: "ok", project_id: project.id, pinned: false });
}));

// GET /projects/v1/admin/:id/usage — usage report
router.get("/projects/v1/admin/:id/usage", (req: Request, res: Response) => {
  assertProjectMatch(req);
  const project = req.project!;
  const limits = getTierLimits(project.tier);

  res.json({
    project_id: project.id,
    tier: project.tier,
    api_calls: project.apiCalls,
    api_calls_limit: limits.apiCalls,
    storage_bytes: project.storageBytes,
    storage_limit_bytes: limits.storageBytes,
    status: project.status,
  });
});

// GET /projects/v1/admin/:id/schema — schema introspection
router.get("/projects/v1/admin/:id/schema", asyncHandler(async (req: Request, res: Response) => {
  assertProjectMatch(req);
  const project = req.project!;

  // Get tables
  const tablesResult = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [project.schemaSlot],
  );

  const tables = [];
  for (const row of tablesResult.rows) {
    const tableName = row.table_name;

    const columnsResult = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [project.schemaSlot, tableName],
    );

    const constraintsResult = await pool.query(
      `SELECT tc.constraint_name, tc.constraint_type,
              pg_get_constraintdef(pgc.oid) as definition
       FROM information_schema.table_constraints tc
       JOIN pg_constraint pgc ON pgc.conname = tc.constraint_name
       WHERE tc.table_schema = $1 AND tc.table_name = $2`,
      [project.schemaSlot, tableName],
    );

    const rlsResult = await pool.query(
      `SELECT relrowsecurity FROM pg_class
       WHERE relname = $1 AND relnamespace = (
         SELECT oid FROM pg_namespace WHERE nspname = $2
       )`,
      [tableName, project.schemaSlot],
    );

    const policiesResult = await pool.query(
      `SELECT polname as name, polcmd as command,
              pg_get_expr(polqual, polrelid) as using_expression,
              pg_get_expr(polwithcheck, polrelid) as check_expression
       FROM pg_policy
       WHERE polrelid = (
         SELECT oid FROM pg_class
         WHERE relname = $1 AND relnamespace = (
           SELECT oid FROM pg_namespace WHERE nspname = $2
         )
       )`,
      [tableName, project.schemaSlot],
    );

    tables.push({
      name: tableName,
      columns: (columnsResult.rows as PgColumn[]).map((c) => ({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === "YES",
        default_value: c.column_default,
      })),
      constraints: (constraintsResult.rows as PgConstraint[]).map((c) => ({
        name: c.constraint_name,
        type: c.constraint_type,
        definition: c.definition,
      })),
      rls_enabled: rlsResult.rows[0]?.relrowsecurity || false,
      policies: (policiesResult.rows as PgPolicy[]).map((p) => ({
        name: p.name,
        command: p.command,
        using_expression: p.using_expression,
        check_expression: p.check_expression,
      })),
    });
  }

  res.json({ schema: project.schemaSlot, tables });
}));

export default router;
