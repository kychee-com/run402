/**
 * AgentDB Gateway — x402-gated Postgres backend provisioning
 *
 * Express monolith: project management, auth, admin, PostgREST proxy, S3 storage.
 * PostgREST runs as ECS sidecar on localhost:3000.
 */

try { await import("dotenv/config"); } catch {}

import express, { Request, Response, NextFunction } from "express";
import { PORT, POSTGREST_URL, SELLER_ADDRESS, MAINNET_NETWORK, TESTNET_NETWORK, TESTNET_FACILITATOR_URL, CDP_API_KEY_ID, RATE_LIMIT_PER_SEC } from "./config.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "./db/pool.js";
import { createPaymentMiddleware } from "./middleware/x402.js";
import { startMeteringFlush, stopMeteringFlush, flushCounters } from "./middleware/metering.js";
import { syncProjects } from "./services/projects.js";
import { initSlots } from "./services/slots.js";
import { startLeaseChecker, stopLeaseChecker } from "./services/leases.js";
import { initIdempotencyTable, idempotencyMiddleware } from "./middleware/idempotency.js";
import projectRoutes from "./routes/projects.js";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import restRoutes from "./routes/rest.js";
import storageRoutes from "./routes/storage.js";

const app = express();

// --- CORS ---
app.use((_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, apikey, Prefer, Accept-Profile, Content-Profile, Idempotency-Key");
  if (_req.method === "OPTIONS") {
    res.status(204).send();
    return;
  }
  next();
});

// --- Rate limiting (in-memory token bucket per project) ---
const rateBuckets = new Map<string, { tokens: number; lastRefill: number }>();

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const apikey = req.headers["apikey"] as string;
  if (!apikey) { next(); return; }

  // Use apikey as bucket key (cheaper than JWT decode)
  const now = Date.now();
  let bucket = rateBuckets.get(apikey);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_PER_SEC, lastRefill: now };
    rateBuckets.set(apikey, bucket);
  }

  // Refill tokens
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(RATE_LIMIT_PER_SEC, bucket.tokens + elapsed * RATE_LIMIT_PER_SEC);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    res.status(429).json({ error: "Rate limit exceeded", retry_after: 1 });
    return;
  }

  bucket.tokens -= 1;
  next();
}

app.use(rateLimit);

// --- Request logging ---
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    const log = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: duration,
      ip: req.ip,
    };
    // Structured JSON log (CloudWatch-friendly)
    if (res.statusCode >= 400) {
      console.error(JSON.stringify(log));
    } else if (req.path !== "/health") {
      console.log(JSON.stringify(log));
    }
  });
  next();
});

// --- Body parsing ---
// Parse JSON for most routes, raw text for SQL migrations and storage uploads
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.endsWith("/sql") || req.path.startsWith("/storage/")) {
    express.text({ type: "*/*", limit: "10mb" })(req, res, next);
  } else {
    express.json({ limit: "1mb" })(req, res, next);
  }
});

// --- Idempotency middleware (for paid endpoints, before x402) ---
app.post("/v1/projects", idempotencyMiddleware);
app.post("/v1/projects/create/:tier", idempotencyMiddleware);
app.post("/v1/projects/:id/renew", idempotencyMiddleware);

// --- x402 payment middleware ---
if (SELLER_ADDRESS) {
  app.use(createPaymentMiddleware());
}

// --- Health check ---
app.get("/health", async (_req: Request, res: Response) => {
  const checks: Record<string, string> = {};

  // Postgres
  try {
    await pool.query("SELECT 1");
    checks.postgres = "ok";
  } catch {
    checks.postgres = "error";
  }

  // PostgREST
  try {
    const resp = await fetch(POSTGREST_URL);
    checks.postgrest = resp.ok ? "ok" : "error";
  } catch {
    checks.postgrest = "error";
  }

  const healthy = checks.postgres === "ok" && checks.postgrest === "ok";
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "healthy" : "degraded",
    checks,
    version: "1.0.0",
  });
});

// --- Paid ping (x402 probe) ---
app.get("/v1/ping", (_req: Request, res: Response) => {
  res.json({ status: "ok", paid: true, timestamp: new Date().toISOString() });
});

// --- Routes ---
app.use(projectRoutes);
app.use(authRoutes);
app.use(adminRoutes);
app.use(restRoutes);
app.use(storageRoutes);

// --- Error handler ---
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// --- Startup ---
let server: ReturnType<typeof app.listen>;

async function initDatabase() {
  // Check if internal schema already exists
  const result = await pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'internal'`,
  );
  if (result.rows.length > 0) {
    console.log("  Database already initialized");
    return;
  }

  console.log("  Initializing database (first run)...");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const sqlPath = join(__dirname, "db", "init.sql");
  const sql = readFileSync(sqlPath, "utf-8");

  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log("  Database initialized successfully");
  } finally {
    client.release();
  }
}

async function start() {
  // Verify Postgres connection
  try {
    await pool.query("SELECT 1 AS ok");
    console.log("  Postgres connection: OK");
  } catch (err: any) {
    console.error("Cannot connect to Postgres:", err.message);
    process.exit(1);
  }

  // Auto-initialize database on first run
  await initDatabase();

  // Initialize idempotency table
  await initIdempotencyTable();

  // Initialize slot allocator
  await initSlots();

  // Sync projects into cache
  await syncProjects();

  // Verify PostgREST is reachable
  try {
    await fetch(POSTGREST_URL);
    console.log("  PostgREST connection: OK");
  } catch (err: any) {
    console.warn("  PostgREST not reachable (will retry on requests):", err.message);
  }

  // Start background tasks
  startMeteringFlush();
  startLeaseChecker();

  server = app.listen(PORT, () => {
    console.log(`\nAgentDB Gateway running on port ${PORT}`);
    console.log(`  Seller wallet:  ${SELLER_ADDRESS || "(not set — x402 disabled)"}`);
    console.log(`  Networks:       ${MAINNET_NETWORK} (mainnet), ${TESTNET_NETWORK} (testnet)`);
    console.log(`  Facilitator:    CDP${CDP_API_KEY_ID ? "" : " — NO KEY, x402 will fail"}`);
    console.log(`  PostgREST:      ${POSTGREST_URL}`);
    console.log(`  Rate limit:     ${RATE_LIMIT_PER_SEC} req/sec per project`);
    console.log(`\nReady for requests.\n`);
  });
}

// --- Graceful shutdown ---
async function shutdown(signal: string) {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  // Stop accepting new connections
  if (server) {
    server.close();
  }

  // Stop background tasks
  stopMeteringFlush();
  stopLeaseChecker();

  // Flush metering counters
  try {
    await flushCounters();
    console.log("  Metering counters flushed");
  } catch (err: any) {
    console.error("  Failed to flush counters:", err.message);
  }

  // Close pool
  try {
    await pool.end();
    console.log("  Database pool closed");
  } catch (err: any) {
    console.error("  Failed to close pool:", err.message);
  }

  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
