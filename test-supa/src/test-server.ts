/**
 * AgentDB Supa test server — x402 gateway + auth + storage + PostgREST proxy
 *
 * An Express server that provides a Supabase-shaped API on top of
 * Postgres + PostgREST running in Docker. Multi-tenant via schema slots.
 *
 * x402 payment gate on POST /v1/projects only ($0.10 Prototype lease).
 * All other routes are free (covered by the lease).
 *
 * Run: npm run server  (after: npm run docker:up)
 */

import { config } from "dotenv";
config();

import express, { Request, Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import pg from "pg";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORAGE_ROOT = join(__dirname, "..", "storage");

// --- Config ---

const PORT = 4022;
const SELLER_ADDRESS = process.env.SELLER_ADDRESS as `0x${string}`;
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-jwt-key-for-agentdb-test-only-32chars!!";
const FACILITATOR_URL = "https://x402.org/facilitator";
const NETWORK = "eip155:84532"; // Base Sepolia testnet
const DB_HOST = process.env.DB_HOST || "localhost";
const POSTGREST_URL = `http://${DB_HOST}:3001`; // PostgREST (Docker or remote)

// x402 pricing — only project creation is gated
const PRICE_CREATE_PROJECT = "$0.10";

if (!SELLER_ADDRESS) {
  console.error("Missing SELLER_ADDRESS in .env — run: npm run generate-wallets");
  process.exit(1);
}

// --- Postgres client (direct connection for admin operations) ---

const pool = new pg.Pool({
  host: DB_HOST,
  port: 5488,
  database: "agentdb",
  user: "postgres",
  password: "postgres",
});

// --- In-memory project registry (supplements internal.projects in Postgres) ---

interface ProjectInfo {
  id: string;
  name: string;
  schemaSlot: string;
  tier: string;
  status: string;
  anonKey: string;
  serviceKey: string;
  apiCalls: number;
  storageBytes: number;
}

const projects = new Map<string, ProjectInfo>();
let nextSlot = 1;

// --- Express app ---

const app = express();

// Parse JSON for most routes, raw text for SQL migrations and storage uploads
app.use((req, res, next) => {
  if (req.path.endsWith("/sql") || req.path.startsWith("/storage/")) {
    express.text({ type: "*/*" })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

// --- x402 payment middleware — only gates POST /v1/projects ---

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

app.use(
  paymentMiddleware(
    {
      "POST /v1/projects": {
        accepts: [
          {
            scheme: "exact",
            price: PRICE_CREATE_PROJECT,
            network: NETWORK,
            payTo: SELLER_ADDRESS,
          },
        ],
        description: "Create a new AgentDB project (Prototype tier — $0.10 lease)",
        mimeType: "application/json",
      },
      // All other routes are free (covered by the lease)
    },
    new x402ResourceServer(facilitatorClient).register(NETWORK, new ExactEvmScheme()),
  ),
);

// =============================================================================
// Project management routes
// =============================================================================

// POST /v1/projects/quote — return tier pricing (free)
app.post("/v1/projects/quote", (_req: Request, res: Response) => {
  res.json({
    tiers: {
      prototype: { price: "$0.10", lease_days: 7, storage_mb: 250, api_calls: 500_000 },
      hobby: { price: "$5.00", lease_days: 30, storage_mb: 1024, api_calls: 5_000_000 },
      team: { price: "$20.00", lease_days: 30, storage_mb: 10240, api_calls: 50_000_000 },
    },
    note: "Test environment — Prototype tier only ($0.10 on Base Sepolia testnet)",
  });
});

// POST /v1/projects — create project via x402 ($0.10)
app.post("/v1/projects", async (req: Request, res: Response) => {
  const name = req.body.name || `project-${Date.now()}`;
  const tier = "prototype"; // test only supports prototype tier

  if (nextSlot > 10) {
    res.status(503).json({ error: "No schema slots available (max 10 in test)" });
    return;
  }

  const slotNum = nextSlot++;
  const schemaSlot = `p${String(slotNum).padStart(4, "0")}`;
  const projectId = `prj_${Date.now()}_${slotNum}`;

  // Sign JWTs
  const anonKey = jwt.sign(
    { role: "anon", project_id: projectId, iss: "agentdb" },
    JWT_SECRET,
    { expiresIn: "7d" },
  );
  const serviceKey = jwt.sign(
    { role: "service_role", project_id: projectId, iss: "agentdb" },
    JWT_SECRET,
    { expiresIn: "7d" },
  );

  // Insert into internal.projects
  try {
    await pool.query(
      `INSERT INTO internal.projects (id, name, schema_slot, tier, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [projectId, name, schemaSlot, tier],
    );
  } catch (err: any) {
    console.error("Failed to insert project:", err.message);
    res.status(500).json({ error: err.message });
    return;
  }

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
  };
  projects.set(projectId, project);

  console.log(`  Created project: ${projectId} (schema: ${schemaSlot})`);

  res.json({
    project_id: projectId,
    url: `http://localhost:${PORT}`,
    anon_key: anonKey,
    service_key: serviceKey,
    schema_slot: schemaSlot,
    tier,
    lease_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
});

// DELETE /v1/projects/:id — archive project, drop schema (free)
app.delete("/v1/projects/:id", async (req: Request, res: Response) => {
  const projectId = req.params.id as string;
  const project = projects.get(projectId);

  if (!project || project.status !== "active") {
    res.status(404).json({ error: "Project not found or already archived" });
    return;
  }

  try {
    // Drop all objects in the schema
    await pool.query(`DROP SCHEMA IF EXISTS ${project.schemaSlot} CASCADE`);
    await pool.query(`CREATE SCHEMA ${project.schemaSlot}`);
    // Re-grant privileges so the slot can be reused
    await pool.query(`GRANT USAGE ON SCHEMA ${project.schemaSlot} TO anon, authenticated, service_role`);
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${project.schemaSlot} GRANT SELECT ON TABLES TO anon`);
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${project.schemaSlot} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated`);
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${project.schemaSlot} GRANT ALL ON TABLES TO service_role`);

    // Mark as archived
    await pool.query(
      `UPDATE internal.projects SET status = 'archived' WHERE id = $1`,
      [projectId],
    );
    project.status = "archived";

    console.log(`  Archived project: ${projectId} (schema ${project.schemaSlot} cleaned)`);
    res.json({ status: "archived", project_id: projectId });
  } catch (err: any) {
    console.error("Failed to archive project:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Admin routes (service_key auth)
// =============================================================================

function authenticateServiceKey(req: Request, res: Response): ProjectInfo | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Bearer token" });
    return null;
  }

  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as any;
    if (payload.role !== "service_role") {
      res.status(403).json({ error: "Requires service_role key" });
      return null;
    }
    const project = projects.get(payload.project_id);
    if (!project || project.status !== "active") {
      res.status(404).json({ error: "Project not found or inactive" });
      return null;
    }
    return project;
  } catch {
    res.status(401).json({ error: "Invalid token" });
    return null;
  }
}

// POST /admin/v1/projects/:id/sql — run SQL migration
app.post("/admin/v1/projects/:id/sql", async (req: Request, res: Response) => {
  const project = authenticateServiceKey(req, res);
  if (!project) return;
  if (project.id !== req.params.id) {
    res.status(403).json({ error: "Token project_id mismatch" });
    return;
  }

  const sql = typeof req.body === "string" ? req.body : req.body?.sql;
  if (!sql) {
    res.status(400).json({ error: "No SQL provided" });
    return;
  }

  try {
    // Execute SQL in the project's schema
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET search_path TO ${project.schemaSlot}`);
      await client.query(sql);
      await client.query("NOTIFY pgrst, 'reload schema'");
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(`  Migration applied to ${project.id} (${project.schemaSlot})`);
    res.json({ status: "ok", schema: project.schemaSlot });
  } catch (err: any) {
    console.error("Migration error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /admin/v1/projects/:id/rls — apply RLS template
app.post("/admin/v1/projects/:id/rls", async (req: Request, res: Response) => {
  const project = authenticateServiceKey(req, res);
  if (!project) return;
  if (project.id !== req.params.id) {
    res.status(403).json({ error: "Token project_id mismatch" });
    return;
  }

  const { template, tables } = req.body;
  if (template !== "user_owns_rows" || !Array.isArray(tables)) {
    res.status(400).json({ error: "Requires template: 'user_owns_rows' and tables array" });
    return;
  }

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET search_path TO ${project.schemaSlot}`);

      for (const table of tables) {
        const tableName = table.table;
        const ownerColumn = table.owner_column;

        // Enable RLS
        await client.query(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`);

        // Force RLS for table owner too (important for security)
        await client.query(`ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY`);

        // Policy: users can only see/modify their own rows
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
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(`  RLS applied to ${project.id}: ${tables.map((t: any) => t.table).join(", ")}`);
    res.json({ status: "ok", tables: tables.map((t: any) => t.table) });
  } catch (err: any) {
    console.error("RLS error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// GET /admin/v1/projects/:id/usage — usage report
app.get("/admin/v1/projects/:id/usage", (req: Request, res: Response) => {
  const project = authenticateServiceKey(req, res);
  if (!project) return;
  if (project.id !== req.params.id) {
    res.status(403).json({ error: "Token project_id mismatch" });
    return;
  }

  const tierLimits: Record<string, { api_calls: number; storage_mb: number }> = {
    prototype: { api_calls: 500_000, storage_mb: 250 },
    hobby: { api_calls: 5_000_000, storage_mb: 1024 },
    team: { api_calls: 50_000_000, storage_mb: 10240 },
  };
  const limits = tierLimits[project.tier] || tierLimits.prototype;

  res.json({
    project_id: project.id,
    tier: project.tier,
    api_calls: project.apiCalls,
    api_calls_limit: limits.api_calls,
    storage_bytes: project.storageBytes,
    storage_limit_bytes: limits.storage_mb * 1024 * 1024,
    status: project.status,
  });
});

// =============================================================================
// Auth routes
// =============================================================================

function projectFromApikey(req: Request, res: Response): ProjectInfo | null {
  const apikey = req.headers["apikey"] as string;
  if (!apikey) {
    res.status(401).json({ error: "Missing apikey header" });
    return null;
  }

  try {
    const payload = jwt.verify(apikey, JWT_SECRET) as any;
    const project = projects.get(payload.project_id);
    if (!project || project.status !== "active") {
      res.status(404).json({ error: "Project not found or inactive" });
      return null;
    }
    return project;
  } catch {
    res.status(401).json({ error: "Invalid apikey" });
    return null;
  }
}

// POST /auth/v1/signup — create user
app.post("/auth/v1/signup", async (req: Request, res: Response) => {
  const project = projectFromApikey(req, res);
  if (!project) return;

  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "email and password required" });
    return;
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO internal.users (project_id, email, password_hash)
       VALUES ($1, $2, $3) RETURNING id, email, created_at`,
      [project.id, email, passwordHash],
    );

    const user = result.rows[0];
    console.log(`  User signed up: ${email} (project: ${project.id})`);

    res.json({
      id: user.id,
      email: user.email,
      created_at: user.created_at,
    });
  } catch (err: any) {
    if (err.code === "23505") {
      res.status(409).json({ error: "User already exists" });
    } else {
      console.error("Signup error:", err.message);
      res.status(500).json({ error: err.message });
    }
  }
});

// POST /auth/v1/token — login, return JWT
app.post("/auth/v1/token", async (req: Request, res: Response) => {
  const project = projectFromApikey(req, res);
  if (!project) return;

  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "email and password required" });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT id, password_hash FROM internal.users
       WHERE project_id = $1 AND email = $2`,
      [project.id, email],
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const accessToken = jwt.sign(
      { sub: user.id, role: "authenticated", project_id: project.id },
      JWT_SECRET,
      { expiresIn: "1h" },
    );

    console.log(`  User logged in: ${email} (project: ${project.id})`);

    res.json({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600,
      user: { id: user.id, email },
    });
  } catch (err: any) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/v1/user — get current user from Bearer token
app.get("/auth/v1/user", async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Bearer token" });
    return;
  }

  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as any;
    if (payload.role !== "authenticated") {
      res.status(401).json({ error: "Not an authenticated user token" });
      return;
    }

    const result = await pool.query(
      `SELECT id, email, created_at FROM internal.users WHERE id = $1`,
      [payload.sub],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json(result.rows[0]);
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
});

// =============================================================================
// PostgREST proxy — /rest/v1/*
// =============================================================================

app.all("/rest/v1/*", async (req: Request, res: Response) => {
  const project = projectFromApikey(req, res);
  if (!project) return;

  // Increment API call counter
  project.apiCalls++;

  // Build PostgREST URL
  const restPath = req.params[0];
  const queryString = new URLSearchParams(req.query as Record<string, string>).toString();
  const url = `${POSTGREST_URL}/${restPath}${queryString ? "?" + queryString : ""}`;

  // Build headers for PostgREST
  const headers: Record<string, string> = {
    "Accept-Profile": project.schemaSlot,
    "Content-Profile": project.schemaSlot,
  };

  // Forward Authorization header (user JWT for RLS)
  if (req.headers.authorization) {
    headers["Authorization"] = req.headers.authorization as string;
  }

  // Forward content type
  if (req.headers["content-type"]) {
    headers["Content-Type"] = req.headers["content-type"] as string;
  }

  // Forward Prefer header (for return=representation, etc.)
  if (req.headers["prefer"]) {
    headers["Prefer"] = req.headers["prefer"] as string;
  }

  try {
    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };

    // Forward body for non-GET requests
    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const pgResponse = await fetch(url, fetchOptions);

    // Forward status and response
    const responseText = await pgResponse.text();
    res.status(pgResponse.status);

    // Forward relevant response headers
    const ct = pgResponse.headers.get("content-type");
    if (ct) res.set("Content-Type", ct);
    const cr = pgResponse.headers.get("content-range");
    if (cr) res.set("Content-Range", cr);

    res.send(responseText);
  } catch (err: any) {
    console.error("PostgREST proxy error:", err.message);
    res.status(502).json({ error: "PostgREST proxy error: " + err.message });
  }
});

// =============================================================================
// Storage routes — local filesystem
// =============================================================================

// POST /storage/v1/object/:bucket/* — upload file
app.post("/storage/v1/object/:bucket/*", (req: Request, res: Response) => {
  const project = projectFromApikey(req, res);
  if (!project) return;

  const bucket = req.params.bucket as string;
  const filePath = req.params[0] as string;
  const storagePath = join(STORAGE_ROOT, project.id, bucket, filePath);

  // Ensure directory exists
  mkdirSync(dirname(storagePath), { recursive: true });

  // Write file (body as raw content)
  const content = typeof req.body === "string"
    ? req.body
    : JSON.stringify(req.body);
  const buffer = Buffer.from(content);
  writeFileSync(storagePath, buffer);

  project.storageBytes += buffer.length;
  project.apiCalls++;

  console.log(`  Storage upload: ${bucket}/${filePath} (${buffer.length}B, project: ${project.id})`);

  res.json({
    key: `${bucket}/${filePath}`,
    size: buffer.length,
  });
});

// GET /storage/v1/object/:bucket/* — download file
app.get("/storage/v1/object/:bucket/*", (req: Request, res: Response) => {
  const project = projectFromApikey(req, res);
  if (!project) return;

  const bucket = req.params.bucket as string;
  const filePath = req.params[0] as string;
  const storagePath = join(STORAGE_ROOT, project.id, bucket, filePath);

  if (!existsSync(storagePath)) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  const content = readFileSync(storagePath);
  project.apiCalls++;

  res.set("Content-Type", "application/octet-stream");
  res.send(content);
});

// =============================================================================
// Start
// =============================================================================

async function start() {
  // Verify Postgres connection and sync slot state
  try {
    await pool.query("SELECT 1 as ok");
    console.log("  Postgres connection: OK");

    // Restore in-memory state from database
    const existing = await pool.query(
      `SELECT id, name, schema_slot, tier, status FROM internal.projects WHERE status = 'active'`,
    );
    for (const row of existing.rows) {
      const slotNum = parseInt(row.schema_slot.replace("p", ""), 10);
      if (slotNum >= nextSlot) nextSlot = slotNum + 1;
      projects.set(row.id, {
        id: row.id,
        name: row.name,
        schemaSlot: row.schema_slot,
        tier: row.tier,
        status: row.status,
        anonKey: "", // not recoverable, but active projects won't be re-issued
        serviceKey: "",
        apiCalls: 0,
        storageBytes: 0,
      });
    }
    console.log(`  Restored ${existing.rows.length} active project(s), next slot: p${String(nextSlot).padStart(4, "0")}`);
  } catch (err: any) {
    console.error("Cannot connect to Postgres:", err.message);
    console.error("Make sure Docker is running: npm run docker:up");
    process.exit(1);
  }

  // Verify PostgREST is reachable
  try {
    const response = await fetch(POSTGREST_URL);
    console.log("  PostgREST connection: OK");
  } catch (err: any) {
    console.error("Cannot connect to PostgREST:", err.message);
    console.error("Make sure Docker is running: npm run docker:up");
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`\nAgentDB Supa test server running at http://localhost:${PORT}`);
    console.log(`  Seller wallet:  ${SELLER_ADDRESS}`);
    console.log(`  Network:        ${NETWORK} (Base Sepolia testnet)`);
    console.log(`  Facilitator:    ${FACILITATOR_URL}`);
    console.log(`  PostgREST:      ${POSTGREST_URL}`);
    console.log(`  Postgres:       ${DB_HOST}:5488`);
    console.log(`  JWT secret:     ${JWT_SECRET.slice(0, 20)}...`);
    console.log(`  Storage:        ${STORAGE_ROOT}`);
    console.log(`  Pricing:`);
    console.log(`    create_project: ${PRICE_CREATE_PROJECT} (Prototype lease via x402)`);
    console.log(`    all other ops:  free (covered by lease)\n`);
    console.log(`Waiting for requests...\n`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
