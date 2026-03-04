import { Router, Request, Response } from "express";
import { pool } from "../db/pool.js";
import { serviceKeyAuth } from "../middleware/apikey.js";
import { getTierLimits } from "@run402/shared";

const router = Router();

// All admin routes require service_key
router.use("/admin/v1", serviceKeyAuth);

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
    hint: "Permissions are managed automatically. Use RLS policies (POST /admin/v1/projects/:id/rls) to control row-level access.",
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

// POST /admin/v1/projects/:id/sql — run SQL migration
router.post("/admin/v1/projects/:id/sql", async (req: Request, res: Response) => {
  const project = req.project!;
  if (project.id !== req.params["id"]) {
    res.status(403).json({ error: "Token project_id mismatch" });
    return;
  }

  const sql = typeof req.body === "string" ? req.body : req.body?.sql;
  if (!sql) {
    res.status(400).json({ error: "No SQL provided" });
    return;
  }

  // Check SQL safety
  const blocked = checkSqlSafety(sql);
  if (blocked) {
    res.status(403).json(blocked);
    return;
  }

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET search_path TO ${project.schemaSlot}`);
      const result = await client.query(sql);
      await client.query("NOTIFY pgrst, 'reload schema'");
      await client.query("COMMIT");

      console.log(`  Migration applied to ${project.id} (${project.schemaSlot})`);
      res.json({
        status: "ok",
        schema: project.schemaSlot,
        rows: result.rows,
        rowCount: result.rowCount,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error("Migration error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /admin/v1/projects/:id/rls — apply RLS template
router.post("/admin/v1/projects/:id/rls", async (req: Request, res: Response) => {
  const project = req.project!;
  if (project.id !== req.params["id"]) {
    res.status(403).json({ error: "Token project_id mismatch" });
    return;
  }

  const { template, tables } = req.body || {};
  const VALID_TEMPLATES = ["user_owns_rows", "public_read", "public_read_write"];
  if (!VALID_TEMPLATES.includes(template) || !Array.isArray(tables)) {
    res.status(400).json({
      error: `Requires template (${VALID_TEMPLATES.join(", ")}) and tables array`,
    });
    return;
  }

  // user_owns_rows requires owner_column on every table
  if (template === "user_owns_rows") {
    for (const t of tables) {
      if (!t.owner_column) {
        res.status(400).json({ error: `owner_column required for table '${t.table}' with user_owns_rows template` });
        return;
      }
    }
  }

  try {
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
              FOR SELECT USING (${ownerColumn} = auth.uid())
          `);
          await client.query(`
            CREATE POLICY "Users can insert own rows" ON ${tableName}
              FOR INSERT WITH CHECK (${ownerColumn} = auth.uid())
          `);
          await client.query(`
            CREATE POLICY "Users can update own rows" ON ${tableName}
              FOR UPDATE USING (${ownerColumn} = auth.uid())
          `);
          await client.query(`
            CREATE POLICY "Users can delete own rows" ON ${tableName}
              FOR DELETE USING (${ownerColumn} = auth.uid())
          `);
        } else if (template === "public_read") {
          // Anyone can read, only authenticated users can write their own rows
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
          // Anyone (including anon) can read and write.
          // anon role only has SELECT by default, so grant write permissions
          // on this specific table (runs server-side, not via user SQL endpoint).
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

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(`  RLS (${template}) applied to ${project.id}: ${tables.map((t: any) => t.table).join(", ")}`);
    res.json({ status: "ok", template, tables: tables.map((t: any) => t.table) });
  } catch (err: any) {
    console.error("RLS error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// GET /admin/v1/projects/:id/usage — usage report
router.get("/admin/v1/projects/:id/usage", (req: Request, res: Response) => {
  const project = req.project!;
  if (project.id !== req.params["id"]) {
    res.status(403).json({ error: "Token project_id mismatch" });
    return;
  }

  const limits = getTierLimits(project.tier);

  res.json({
    project_id: project.id,
    tier: project.tier,
    api_calls: project.apiCalls,
    api_calls_limit: limits.apiCalls,
    storage_bytes: project.storageBytes,
    storage_limit_bytes: limits.storageBytes,
    lease_expires_at: project.leaseExpiresAt.toISOString(),
    status: project.status,
  });
});

// GET /admin/v1/projects/:id/schema — schema introspection
router.get("/admin/v1/projects/:id/schema", async (req: Request, res: Response) => {
  const project = req.project!;
  if (project.id !== req.params["id"]) {
    res.status(403).json({ error: "Token project_id mismatch" });
    return;
  }

  try {
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

      // Get columns
      const columnsResult = await pool.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [project.schemaSlot, tableName],
      );

      // Get constraints
      const constraintsResult = await pool.query(
        `SELECT tc.constraint_name, tc.constraint_type,
                pg_get_constraintdef(pgc.oid) as definition
         FROM information_schema.table_constraints tc
         JOIN pg_constraint pgc ON pgc.conname = tc.constraint_name
         WHERE tc.table_schema = $1 AND tc.table_name = $2`,
        [project.schemaSlot, tableName],
      );

      // Check RLS status
      const rlsResult = await pool.query(
        `SELECT relrowsecurity FROM pg_class
         WHERE relname = $1 AND relnamespace = (
           SELECT oid FROM pg_namespace WHERE nspname = $2
         )`,
        [tableName, project.schemaSlot],
      );

      // Get RLS policies
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
        columns: columnsResult.rows.map((c: any) => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === "YES",
          default_value: c.column_default,
        })),
        constraints: constraintsResult.rows.map((c: any) => ({
          name: c.constraint_name,
          type: c.constraint_type,
          definition: c.definition,
        })),
        rls_enabled: rlsResult.rows[0]?.relrowsecurity || false,
        policies: policiesResult.rows.map((p: any) => ({
          name: p.name,
          command: p.command,
          using_expression: p.using_expression,
          check_expression: p.check_expression,
        })),
      });
    }

    res.json({ schema: project.schemaSlot, tables });
  } catch (err: any) {
    console.error("Schema introspection error:", err.message);
    res.status(500).json({ error: "Schema introspection failed" });
  }
});

export default router;
