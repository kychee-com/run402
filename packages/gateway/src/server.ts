/**
 * AgentDB Gateway — x402-gated Postgres backend provisioning
 *
 * Express monolith: project management, auth, admin, PostgREST proxy, S3 storage.
 * PostgREST runs as ECS sidecar on localhost:3000.
 */

try { await import("dotenv/config"); } catch {}

import express, { Request, Response, NextFunction, ErrorRequestHandler } from "express";
import { errorMessage } from "./utils/errors.js";
import { HttpError } from "./utils/async-handler.js";
import { PORT, POSTGREST_URL, SELLER_ADDRESS, MAINNET_NETWORK, TESTNET_NETWORK, TESTNET_FACILITATOR_URL, CDP_API_KEY_ID, RATE_LIMIT_PER_SEC, FAUCET_TREASURY_KEY, FACILITATOR_PROVIDER } from "./config.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "./db/pool.js";
import { createPaymentMiddleware } from "./middleware/x402.js";
import { startMeteringFlush, stopMeteringFlush, flushCounters } from "./middleware/metering.js";
import { syncProjects } from "./services/projects.js";
import { initSlots } from "./services/slots.js";
import { startLeaseChecker, stopLeaseChecker } from "./services/leases.js";
import { startFaucetRefill, stopFaucetRefill } from "./services/faucet.js";
import { initIdempotencyTable, idempotencyMiddleware } from "./middleware/idempotency.js";
import { initDeploymentsTable } from "./services/deployments.js";
import { initSubdomainsTable } from "./services/subdomains.js";
import { initFunctionsTable } from "./services/functions.js";
import { subdomainMiddleware } from "./middleware/subdomain.js";
import projectRoutes from "./routes/projects.js";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import restRoutes from "./routes/rest.js";
import storageRoutes from "./routes/storage.js";
import faucetRoutes from "./routes/faucet.js";
import deploymentRoutes from "./routes/deployments.js";
import messageRoutes from "./routes/message.js";
import stripeRoutes from "./routes/stripe.js";
import subdomainRoutes from "./routes/subdomains.js";
import functionsRoutes from "./routes/functions.js";
import generateImageRoutes from "./routes/generate-image.js";
import bundleRoutes from "./routes/bundle.js";

const app = express();

// Trust ALB proxy for correct req.ip
app.set("trust proxy", true);

// --- Custom subdomain routing (must be before CORS/body parsing) ---
app.use(subdomainMiddleware);

// --- CORS ---
app.use((_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, apikey, Prefer, Accept-Profile, Content-Profile, Idempotency-Key, X-Wallet-Address");
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
// Parse JSON for most routes, raw for storage uploads, text for SQL migrations
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith("/storage/")) {
    express.raw({ type: "*/*", limit: "10mb" })(req, res, next);
  } else if (req.path.endsWith("/sql")) {
    express.text({ type: "*/*", limit: "10mb" })(req, res, next);
  } else if ((req.path === "/v1/deployments" || req.path.startsWith("/v1/deploy/")) && req.method === "POST") {
    express.json({ limit: "50mb" })(req, res, next);
  } else {
    express.json({ limit: "1mb" })(req, res, next);
  }
});

// Body-parser error handler — return 4xx for bad input, not 500
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Express ErrorRequestHandler types err as any
const bodyParserErrorHandler: ErrorRequestHandler = (err: any, _req, res, next) => {
  if (err.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON in request body" });
    return;
  }
  if (err.type === "entity.too.large") {
    res.status(413).json({ error: "Request body too large" });
    return;
  }
  if (err.type === "encoding.unsupported" || err.type === "charset.unsupported") {
    res.status(415).json({ error: "Unsupported content encoding" });
    return;
  }
  next(err);
};
app.use(bodyParserErrorHandler);

// --- Idempotency middleware (for paid endpoints, before x402) ---
app.post("/v1/projects", idempotencyMiddleware);
app.post("/v1/projects/create/:tier", idempotencyMiddleware);
app.post("/v1/projects/:id/renew", idempotencyMiddleware);
app.post("/v1/deployments", idempotencyMiddleware);
app.post("/v1/message", idempotencyMiddleware);
app.post("/v1/generate-image", idempotencyMiddleware);
app.post("/v1/deploy/:tier", idempotencyMiddleware);

// --- x402 payment middleware ---
if (SELLER_ADDRESS) {
  app.use(createPaymentMiddleware());
}

// --- x402 discovery (for x402scan.com) ---
app.get("/.well-known/x402", (_req: Request, res: Response) => {
  res.json({
    version: 1,
    resources: [
      "https://api.run402.com/v1/projects",
      "https://api.run402.com/v1/projects/create/prototype",
      "https://api.run402.com/v1/projects/create/hobby",
      "https://api.run402.com/v1/projects/create/team",
      "https://api.run402.com/v1/deployments",
      "https://api.run402.com/v1/ping",
      "https://api.run402.com/v1/message",
      "https://api.run402.com/v1/generate-image",
      "https://api.run402.com/v1/deploy/prototype",
      "https://api.run402.com/v1/deploy/hobby",
      "https://api.run402.com/v1/deploy/team",
    ],
  });
});

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
    version: "1.0.4",
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
app.use(faucetRoutes);
app.use(deploymentRoutes);
app.use(messageRoutes);
app.use(stripeRoutes);
app.use(subdomainRoutes);
app.use(functionsRoutes);
app.use(generateImageRoutes);
app.use(bundleRoutes);

// --- Central error handler ---
// Routes using asyncHandler() forward errors here automatically.
// HttpError instances set the status code; everything else becomes 500.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  console.error("Unhandled error:", errorMessage(err));
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

/**
 * Apply idempotent schema migrations for existing deployments.
 */
async function applyMigrations() {
  // v1.1: Grant default sequence privileges (fixes SERIAL/BIGSERIAL permission errors)
  const result = await pool.query(
    `SELECT schema_name FROM information_schema.schemata WHERE schema_name ~ '^p\\d{4}$'`,
  );
  if (result.rows.length > 0) {
    const client = await pool.connect();
    try {
      for (const row of result.rows) {
        const slot = row.schema_name;
        await client.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${slot} GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role`,
        );
      }
      console.log(`  Applied sequence grants to ${result.rows.length} schema slots`);
    } finally {
      client.release();
    }
  }

  // v1.2: wallet_address for subscription linking
  await pool.query(`ALTER TABLE internal.projects ADD COLUMN IF NOT EXISTS wallet_address TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_projects_wallet ON internal.projects(wallet_address) WHERE wallet_address IS NOT NULL`);

  // v1.3: pinned projects (lease never expires)
  await pool.query(`ALTER TABLE internal.projects ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false`);
}

async function start() {
  // Verify Postgres connection
  try {
    await pool.query("SELECT 1 AS ok");
    console.log("  Postgres connection: OK");
  } catch (err: unknown) {
    console.error("Cannot connect to Postgres:", errorMessage(err));
    process.exit(1);
  }

  // Auto-initialize database on first run
  await initDatabase();

  // Apply pending migrations (idempotent)
  await applyMigrations();

  // Initialize idempotency table
  await initIdempotencyTable();

  // Initialize deployments table
  await initDeploymentsTable();

  // Initialize subdomains table
  await initSubdomainsTable();

  // Initialize functions + secrets tables
  await initFunctionsTable();

  // Initialize slot allocator
  await initSlots();

  // Sync projects into cache
  await syncProjects();

  // Verify PostgREST is reachable
  try {
    await fetch(POSTGREST_URL);
    console.log("  PostgREST connection: OK");
  } catch (err: unknown) {
    console.warn("  PostgREST not reachable (will retry on requests):", errorMessage(err));
  }

  // Start background tasks
  startMeteringFlush();
  startLeaseChecker();
  startFaucetRefill();

  server = app.listen(PORT, () => {
    console.log(`\nAgentDB Gateway running on port ${PORT}`);
    console.log(`  Seller wallet:  ${SELLER_ADDRESS || "(not set — x402 disabled)"}`);
    console.log(`  Networks:       ${MAINNET_NETWORK} (mainnet), ${TESTNET_NETWORK} (testnet)`);
    console.log(`  Facilitator:    ${FACILITATOR_PROVIDER}${FACILITATOR_PROVIDER === "stripe" ? "" : (CDP_API_KEY_ID ? "" : " — NO KEY, x402 will fail")}`);
    console.log(`  PostgREST:      ${POSTGREST_URL}`);
    console.log(`  Rate limit:     ${RATE_LIMIT_PER_SEC} req/sec per project`);
    console.log(`  Faucet:         ${FAUCET_TREASURY_KEY ? "enabled" : "disabled (no FAUCET_TREASURY_KEY)"}`);
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
  stopFaucetRefill();

  // Flush metering counters
  try {
    await flushCounters();
    console.log("  Metering counters flushed");
  } catch (err: unknown) {
    console.error("  Failed to flush counters:", errorMessage(err));
  }

  // Close pool
  try {
    await pool.end();
    console.log("  Database pool closed");
  } catch (err: unknown) {
    console.error("  Failed to close pool:", errorMessage(err));
  }

  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
