/**
 * AgentDB Gateway — x402-gated Postgres backend provisioning
 *
 * Express monolith: project management, auth, admin, PostgREST proxy, S3 storage.
 * PostgREST runs as ECS sidecar on localhost:3000.
 */

try { await import("dotenv/config"); } catch {}

import Bugsnag from "@bugsnag/js";
import BugsnagPluginExpress from "@bugsnag/plugin-express";
import express, { Request, Response, NextFunction, ErrorRequestHandler } from "express";
import { errorMessage } from "./utils/errors.js";
import { HttpError } from "./utils/async-handler.js";
import { PORT, POSTGREST_URL, SELLER_ADDRESS, MAINNET_NETWORK, TESTNET_NETWORK, TESTNET_FACILITATOR_URL, CDP_API_KEY_ID, RATE_LIMIT_PER_SEC, FAUCET_TREASURY_KEY, FACILITATOR_PROVIDER, BUGSNAG_API_KEY, RELEASE_STAGE, S3_BUCKET, S3_REGION, LAMBDA_ROLE_ARN } from "./config.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "./db/pool.js";
import { sql } from "./db/sql.js";
import { createPaymentMiddleware } from "./middleware/x402.js";
import { startMeteringFlush, stopMeteringFlush, flushCounters } from "./middleware/metering.js";
import { syncProjects } from "./services/projects.js";
import { initSlots } from "./services/slots.js";
import { startLeaseChecker, stopLeaseChecker } from "./services/leases.js";
import { startFaucetRefill, stopFaucetRefill } from "./services/faucet.js";
import { startDemoResetChecker, stopDemoResetChecker } from "./services/demo.js";
import { initIdempotencyTable, idempotencyMiddleware } from "./middleware/idempotency.js";
import { initDeploymentsTable } from "./services/deployments.js";
import { initSubdomainsTable } from "./services/subdomains.js";
import { initFunctionsTable } from "./services/functions.js";
import { initAdminWalletsTable } from "./services/admin-wallets.js";
import { subdomainMiddleware } from "./middleware/subdomain.js";
import projectRoutes from "./routes/projects.js";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import restRoutes from "./routes/rest.js";
import storageRoutes from "./routes/storage.js";
import faucetRoutes from "./routes/faucet.js";
import deploymentRoutes from "./routes/deployments.js";
import messageRoutes from "./routes/message.js";
import billingRoutes from "./routes/billing.js";
import billingStripeRoutes from "./routes/billing-stripe.js";
import subdomainRoutes from "./routes/subdomains.js";
import functionsRoutes from "./routes/functions.js";
import generateImageRoutes from "./routes/generate-image.js";
import bundleRoutes from "./routes/bundle.js";
import publishRoutes from "./routes/publish.js";
import adminDashboardRoutes from "./routes/admin-dashboard.js";
import adminLlmsTxtRoutes from "./routes/admin-llms-txt.js";
import adminWalletRoutes from "./routes/admin-wallet.js";
import attributionRoutes from "./routes/attribution.js";
import contactRoutes from "./routes/contact.js";
import mailboxRoutes from "./routes/mailboxes.js";
import tierRoutes from "./routes/tiers.js";
import openapiRoutes from "./routes/openapi.js";
import { initAppVersionsTables } from "./services/publish.js";
import { initMailboxTables } from "./services/mailbox.js";
import { cleanupExpiredOAuthData } from "./services/oauth.js";

Bugsnag.start({
  apiKey: BUGSNAG_API_KEY || "disabled",
  releaseStage: BUGSNAG_API_KEY ? RELEASE_STAGE : "disabled",
  enabledReleaseStages: ["production"],
  plugins: [BugsnagPluginExpress],
  onError(event) {
    const orig = event.originalError as { statusCode?: number; name?: string; code?: string; message?: string };
    // Don't report expected client errors (4xx) — these are validation,
    // rate limits, not-found, etc. Only 5xx errors are real bugs.
    if (orig?.name === "HttpError" && orig.statusCode && orig.statusCode < 500) {
      return false;
    }
    // Don't report "not configured" 503s — expected when optional features
    // (Lambda, OAuth, Stripe, etc.) aren't set up in this environment.
    if (orig?.name === "HttpError" && orig.statusCode === 503 && orig.message?.includes("not configured")) {
      return false;
    }
    // Don't report user SQL errors (e.g. "relation X does not exist").
    // These are user schema mistakes, not gateway bugs.
    if (orig?.code === "42P01" || orig?.code === "42703" || orig?.code === "42601") {
      return false;
    }
    // Don't report user function errors — FunctionError is our own class
    // for 4xx responses (not found, quota exceeded, etc.).
    if (orig?.name === "FunctionError") {
      return false;
    }
    // Don't report transient pg pool errors (connection drops during Aurora restarts).
    if (orig?.message?.includes("already been released to the pool")) {
      return false;
    }
  },
});
const bugsnagMiddleware = Bugsnag.getPlugin("express")!;

const app = express();


/**
 * Initialize x402 payment middleware with retries.
 * The facilitator may be temporarily unreachable during cold start.
 */
async function initPaymentMiddlewareWithRetry(maxAttempts = 5, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await createPaymentMiddleware();
    } catch (err) {
      console.error(`x402 init attempt ${attempt}/${maxAttempts} failed:`, err);
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("unreachable");
}

// Bugsnag request handler must be the first middleware
app.use(bugsnagMiddleware.requestHandler);

// Trust ALB proxy for correct req.ip
app.set("trust proxy", true);

// --- Custom subdomain routing (must be before CORS/body parsing) ---
app.use(subdomainMiddleware);

// --- CORS ---
app.use((_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, apikey, Prefer, Accept-Profile, Content-Profile, Idempotency-Key, X-Wallet-Address, X-Run402-Wallet, X-Run402-Signature, X-Run402-Timestamp");
  res.set("Access-Control-Expose-Headers", "X-Run402-Settlement-Rail, X-Run402-Allowance-Remaining, X-Run402-Hint, WWW-Authenticate");
  if (_req.method === "OPTIONS") {
    res.status(204).send();
    return;
  }
  next();
});

// --- Rate limiting (in-memory token bucket per project) ---
const rateBuckets = new Map<string, { tokens: number; lastRefill: number }>();

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  // Use wallet address or apikey as bucket key
  const walletHeader = req.headers["x-run402-wallet"] as string | undefined;
  const apikey = req.headers["apikey"] as string;
  const bucketKey = walletHeader?.toLowerCase() || apikey;
  if (!bucketKey) { next(); return; }

  const now = Date.now();
  let bucket = rateBuckets.get(bucketKey);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_PER_SEC, lastRefill: now };
    rateBuckets.set(bucketKey, bucket);
  }

  // Refill tokens
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(RATE_LIMIT_PER_SEC, bucket.tokens + elapsed * RATE_LIMIT_PER_SEC);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    res.set("Retry-After", "1");
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

// --- Stripe webhook raw body (must be before JSON parser) ---
app.post("/webhooks/v1/stripe", express.raw({ type: "application/json" }));

// --- Body parsing ---
// Parse JSON for most routes, raw for storage uploads, text for SQL migrations
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/webhooks/v1/stripe") {
    // Already parsed as raw above
    next();
    return;
  }
  if (req.path.startsWith("/storage/")) {
    express.raw({ type: "*/*", limit: "10mb" })(req, res, next);
  } else if (req.path.endsWith("/sql")) {
    express.text({ type: "*/*", limit: "10mb" })(req, res, next);
  } else if ((req.path === "/deployments/v1" || req.path === "/deploy/v1") && req.method === "POST") {
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
app.post("/tiers/v1/:tier", idempotencyMiddleware);
app.post("/projects/v1", idempotencyMiddleware);
app.post("/deploy/v1", idempotencyMiddleware);
app.post("/fork/v1", idempotencyMiddleware);
app.post("/generate-image/v1", idempotencyMiddleware);

// --- x402 payment middleware ---
if (SELLER_ADDRESS) {
  try {
    app.use(await initPaymentMiddlewareWithRetry());
  } catch (err) {
    console.error("\nx402 payment middleware failed to initialize.");
    console.error("  Cause:", (err as Error).message);
    console.error("  Fix: set SELLER_ADDRESS + CDP_API_KEY_ID + CDP_API_KEY_SECRET (or unset SELLER_ADDRESS to disable x402)\n");
    process.exit(1);
  }
}

// --- OpenAPI discovery (canonical) ---
app.use(openapiRoutes);

// --- x402 discovery (fallback — OpenAPI at /openapi.json is canonical) ---
app.get("/.well-known/x402", (_req: Request, res: Response) => {
  const base = "https://api.run402.com";
  const paid = [
    "/tiers/v1/prototype",
    "/tiers/v1/hobby",
    "/tiers/v1/team",
    "/generate-image/v1",
  ];
  res.json({
    version: 1,
    description: "Run402 — full-stack infrastructure for AI agents. Postgres databases, static hosting, serverless functions, and image generation. Pay with USDC via x402 or MPP.",
    instructions: "Subscribe to a tier (prototype/hobby/team) to unlock project provisioning, then create projects and deploy. Image generation is per-call. See /openapi.json for full endpoint details.",
    resources: paid.map((p) => `${base}${p}`),
    mppResources: paid.map((p) => `${base}${p}`),
  });
});

// --- Health check ---
app.get("/health", async (_req: Request, res: Response) => {
  const checks: Record<string, string> = {};

  // Postgres
  try {
    await pool.query(sql("SELECT 1"));
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

  // S3 (Cloud Object Storage)
  if (S3_BUCKET) {
    try {
      const { S3Client, HeadBucketCommand } = await import("@aws-sdk/client-s3");
      await new S3Client({ region: S3_REGION }).send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
      checks.s3 = "ok";
    } catch {
      checks.s3 = "error";
    }
  }

  // CloudFront (Content Delivery Network)
  try {
    const cfResp = await fetch("https://run402.com/favicon.svg", { method: "HEAD" });
    checks.cloudfront = cfResp.ok ? "ok" : "error";
  } catch {
    checks.cloudfront = "error";
  }

  const healthy = checks.postgres === "ok" && checks.postgrest === "ok";
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "healthy" : "degraded",
    checks,
    version: "1.0.4",
  });
});

// --- Human-friendly health page ---
app.get("/health-humans", (_req: Request, res: Response) => {
  res.type("html").send(healthHumanPage());
});

// --- Status proxy (avoids CORS issues for health-humans page) ---
let statusCache: { data: string; ts: number } | null = null;
app.get("/status", async (_req: Request, res: Response) => {
  try {
    if (!statusCache || Date.now() - statusCache.ts > 30_000) {
      const r = await fetch("https://run402.com/status/v1.json");
      statusCache = { data: await r.text(), ts: Date.now() };
    }
    res.set("Content-Type", "application/json");
    res.set("Cache-Control", "public, max-age=30");
    res.send(statusCache.data);
  } catch {
    res.redirect(302, "https://run402.com/status/v1.json");
  }
});

// --- Public stats (wallet count for landing page) ---
let publicStatsCache: { data: object; ts: number } | null = null;
app.get("/public/stats", async (_req: Request, res: Response) => {
  try {
    if (!publicStatsCache || Date.now() - publicStatsCache.ts > 60_000) {
      const result = await pool.query(sql(`
        SELECT COUNT(DISTINCT wallet)::int AS count FROM (
          SELECT wallet_address AS wallet FROM internal.wallet_sightings
          UNION
          SELECT wallet_address FROM internal.billing_account_wallets
          UNION
          SELECT wallet_address FROM internal.projects WHERE wallet_address IS NOT NULL
          UNION
          SELECT wallet_address FROM internal.charge_authorizations
        ) all_wallets
      `));
      publicStatsCache = { data: { wallets: result.rows[0]?.count || 0 }, ts: Date.now() };
    }
    res.set("Cache-Control", "public, max-age=60");
    res.json(publicStatsCache.data);
  } catch {
    res.json({ wallets: 0 });
  }
});

// --- Ping (wallet auth, free with tier) ---
import { walletAuth } from "./middleware/wallet-auth.js";
app.get("/ping/v1", walletAuth(false), (_req: Request, res: Response) => {
  res.json({ status: "ok", wallet: _req.walletAddress, tier: _req.walletTier, timestamp: new Date().toISOString() });
});

// --- Routes ---
app.use(tierRoutes);
app.use(adminDashboardRoutes);
app.use(adminLlmsTxtRoutes);
app.use(adminWalletRoutes);
app.use(billingRoutes);
app.use(billingStripeRoutes);
app.use(projectRoutes);
app.use(authRoutes);
app.use(faucetRoutes);
app.use(adminRoutes);
app.use(restRoutes);
app.use(storageRoutes);
app.use(deploymentRoutes);
app.use(messageRoutes);
app.use(subdomainRoutes);
app.use(functionsRoutes);
app.use(generateImageRoutes);
app.use(bundleRoutes);
app.use(publishRoutes);
app.use(attributionRoutes);
app.use(contactRoutes);
app.use(mailboxRoutes);

// --- Bugsnag error handler (must be before central error handler) ---
app.use(bugsnagMiddleware.errorHandler);

// --- Central error handler ---
// Routes using asyncHandler() forward errors here automatically.
// HttpError instances set the status code; everything else becomes 500.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    if (err.statusCode >= 500) {
      console.error(JSON.stringify({ level: "error", status: err.statusCode, error: err.message, stack: err.stack }));
    }
    res.status(err.statusCode).json(err.body || { error: err.message });
    return;
  }
  console.error(JSON.stringify({ level: "error", status: 500, error: errorMessage(err), stack: err instanceof Error ? err.stack : undefined }));
  res.status(500).json({ error: "Internal server error" });
});

// --- Health page HTML ---
function healthHumanPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Run402 — System Status</title>
<link rel="icon" href="https://run402.com/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0A0A0F;color:#E0E0E0;font-family:'Inter',system-ui,sans-serif;min-height:100vh;overflow-x:hidden}
.bg{position:fixed;top:0;left:0;right:0;bottom:0;z-index:0;overflow:hidden;pointer-events:none}
.bg canvas{width:100%;height:100%}
.wrap{position:relative;z-index:1;max-width:720px;margin:0 auto;padding:80px 24px 60px}
.badge{display:inline-block;font-family:'JetBrains Mono',monospace;font-size:11px;color:#00FF9F;border:1px solid rgba(0,255,159,0.3);border-radius:4px;padding:4px 10px;margin-bottom:20px;letter-spacing:.5px}
h1{font-size:clamp(28px,5vw,42px);font-weight:700;color:#fff;margin-bottom:6px}
h1 .g{color:#00FF9F}
.sub{font-size:15px;color:#9CA3AF;margin-bottom:40px}

/* Cards */
.card{background:#12121A;border:1px solid #1E1E2A;border-radius:12px;padding:28px;margin-bottom:16px;transition:border-color .3s}
.card.ok{border-color:rgba(0,255,159,0.2)}
.card.err{border-color:rgba(255,80,80,0.3)}
.card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.card-title{font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:500;color:#fff;letter-spacing:.3px}
.pill{font-family:'JetBrains Mono',monospace;font-size:11px;padding:4px 12px;border-radius:20px;font-weight:500;letter-spacing:.5px}
.pill.ok{background:rgba(0,255,159,0.1);color:#00FF9F;box-shadow:0 0 12px rgba(0,255,159,0.08)}
.pill.err{background:rgba(255,80,80,0.1);color:#FF5050;box-shadow:0 0 12px rgba(255,80,80,0.08)}
.pill.load{background:rgba(255,255,255,0.05);color:#4B5563}

/* Service checks */
.checks{display:flex;flex-direction:column;gap:10px}
.check{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(255,255,255,0.02);border-radius:8px;border:1px solid rgba(255,255,255,0.04)}
.check-name{font-size:13px;color:#9CA3AF;display:flex;align-items:center;gap:8px}
.check-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.check-dot.ok{background:#00FF9F;box-shadow:0 0 8px rgba(0,255,159,0.5)}
.check-dot.err{background:#FF5050;box-shadow:0 0 8px rgba(255,80,80,0.5)}
.check-dot.load{background:#4B5563}
.check-ms{font-family:'JetBrains Mono',monospace;font-size:12px;color:#4B5563}

/* Meta grid */
.meta{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px}
.meta-item{background:#12121A;border:1px solid #1E1E2A;border-radius:10px;padding:16px}
.meta-label{font-size:11px;color:#4B5563;text-transform:uppercase;letter-spacing:.8px;font-family:'JetBrains Mono',monospace;margin-bottom:4px}
.meta-value{font-size:18px;font-weight:600;color:#fff;font-family:'JetBrains Mono',monospace}
.meta-value .g{color:#00FF9F}

/* Pulse ring */
.pulse-ring{display:inline-block;width:10px;height:10px;border-radius:50%;position:relative;vertical-align:middle;margin-right:6px}
.pulse-ring.ok{background:#00FF9F}
.pulse-ring.err{background:#FF5050}
.pulse-ring::after{content:'';position:absolute;top:-4px;left:-4px;width:18px;height:18px;border-radius:50%;animation:pulse 2s ease-in-out infinite;opacity:0.4}
.pulse-ring.ok::after{background:#00FF9F}
.pulse-ring.err::after{background:#FF5050}
@keyframes pulse{0%,100%{transform:scale(1);opacity:0.4}50%{transform:scale(1.6);opacity:0}}

/* Uptime section */
.uptime-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
.uptime-card{background:#12121A;border:1px solid #1E1E2A;border-radius:12px;padding:20px;text-align:center;position:relative;overflow:hidden}
.uptime-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#00FF9F,transparent);opacity:0;transition:opacity .6s}
.uptime-card.loaded::before{opacity:1;animation:shimmer 3s ease-in-out infinite}
@keyframes shimmer{0%{opacity:0.3;transform:translateX(-100%)}50%{opacity:1;transform:translateX(0)}100%{opacity:0.3;transform:translateX(100%)}}
.uptime-window{font-size:11px;color:#4B5563;text-transform:uppercase;letter-spacing:.8px;font-family:'JetBrains Mono',monospace;margin-bottom:10px}
.uptime-pct{font-size:32px;font-weight:700;font-family:'JetBrains Mono',monospace;color:#fff;line-height:1}
.uptime-pct .g{color:#00FF9F}
.uptime-pct .dim{color:#4B5563;font-size:20px}
.uptime-probes{font-size:11px;color:#4B5563;font-family:'JetBrains Mono',monospace;margin-top:8px}
.uptime-bar{height:4px;background:#1E1E2A;border-radius:2px;margin-top:12px;overflow:hidden}
.uptime-fill{height:100%;border-radius:2px;background:#00FF9F;width:0;transition:width 1.2s cubic-bezier(0.22,1,0.36,1)}

/* Capability grid */
.cap-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.cap-item{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(255,255,255,0.02);border-radius:6px;border:1px solid rgba(255,255,255,0.04);opacity:0;animation:fadeSlide .4s ease forwards}
@keyframes fadeSlide{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.cap-name{font-size:12px;color:#9CA3AF;font-family:'JetBrains Mono',monospace}
.cap-pct{font-size:12px;font-family:'JetBrains Mono',monospace;color:#00FF9F}
.cap-pct.warn{color:#FBBF24}
.cap-pct.bad{color:#FF5050}

/* Ticker counter animation */
.ticker{display:inline-block}
.ticker-digit{display:inline-block;animation:countUp .6s cubic-bezier(0.22,1,0.36,1) forwards;opacity:0;transform:translateY(10px)}
@keyframes countUp{to{opacity:1;transform:translateY(0)}}

/* Timestamp & footer */
.ts{font-size:12px;color:#4B5563;text-align:center;margin-top:24px;font-family:'JetBrains Mono',monospace}
.footer{border-top:1px solid #1E1E2A;padding-top:24px;margin-top:40px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
.footer-text{font-size:13px;color:#4B5563}
.footer a{color:#00FF9F;text-decoration:none;font-family:'JetBrains Mono',monospace;font-size:13px}
.footer a:hover{text-decoration:underline}
@media(max-width:540px){.uptime-grid{grid-template-columns:1fr}.cap-grid{grid-template-columns:1fr}.meta{grid-template-columns:1fr}.wrap{padding:60px 16px 40px}}
</style>
</head>
<body>
<div class="bg"><canvas id="grid"></canvas></div>
<div class="wrap">
  <div class="badge">SYSTEM STATUS</div>
  <h1><span class="g">run402</span> status</h1>
  <p class="sub">Real-time health of the Run402 infrastructure</p>

  <div class="meta">
    <div class="meta-item">
      <div class="meta-label">Version</div>
      <div class="meta-value" id="version">...</div>
    </div>
    <div class="meta-item">
      <div class="meta-label">Overall</div>
      <div class="meta-value" id="overall"><span class="pulse-ring load"></span> checking</div>
    </div>
  </div>

  <div id="uptime-section">
    <div class="uptime-grid" id="uptime-grid">
      <div class="uptime-card" id="up-24h">
        <div class="uptime-window">Last 24 hours</div>
        <div class="uptime-pct" id="pct-24h"><span class="dim">--.--</span><span class="dim">%</span></div>
        <div class="uptime-probes" id="probes-24h">&mdash;</div>
        <div class="uptime-bar"><div class="uptime-fill" id="bar-24h"></div></div>
      </div>
      <div class="uptime-card" id="up-7d">
        <div class="uptime-window">Last 7 days</div>
        <div class="uptime-pct" id="pct-7d"><span class="dim">--.--</span><span class="dim">%</span></div>
        <div class="uptime-probes" id="probes-7d">&mdash;</div>
        <div class="uptime-bar"><div class="uptime-fill" id="bar-7d"></div></div>
      </div>
      <div class="uptime-card" id="up-30d">
        <div class="uptime-window">Last 30 days</div>
        <div class="uptime-pct" id="pct-30d"><span class="dim">--.--</span><span class="dim">%</span></div>
        <div class="uptime-probes" id="probes-30d">&mdash;</div>
        <div class="uptime-bar"><div class="uptime-fill" id="bar-30d"></div></div>
      </div>
    </div>
  </div>

  <div class="card" id="main-card">
    <div class="card-head">
      <span class="card-title">Services</span>
      <span class="pill load" id="main-pill">CHECKING</span>
    </div>
    <div class="checks" id="checks">
      <div class="check"><span class="check-name"><span class="check-dot load"></span> Gateway API</span><span class="check-ms">...</span></div>
      <div class="check"><span class="check-name"><span class="check-dot load"></span> PostgreSQL (Aurora)</span><span class="check-ms">...</span></div>
      <div class="check"><span class="check-name"><span class="check-dot load"></span> PostgREST</span><span class="check-ms">...</span></div>
      <div class="check"><span class="check-name"><span class="check-dot load"></span> Cloud Object Storage</span><span class="check-ms">...</span></div>
      <div class="check"><span class="check-name"><span class="check-dot load"></span> Content Delivery Network</span><span class="check-ms">...</span></div>
    </div>
  </div>

  <div class="card" id="cap-card" style="display:none">
    <div class="card-head">
      <span class="card-title">Capability Uptime <span style="color:#4B5563;font-weight:400">(30d)</span></span>
    </div>
    <div class="cap-grid" id="cap-grid"></div>
  </div>

  <div class="ts" id="timestamp"></div>

  <div class="footer">
    <span class="footer-text">Run402 &mdash; full stack for agents</span>
    <span>
      <a href="https://run402.com/humans">Home</a> &nbsp;&middot;&nbsp;
      <a href="/health">API (JSON)</a> &nbsp;&middot;&nbsp;
      <a href="/status">Status JSON</a>
    </span>
  </div>
</div>

<script>
// Grid background
(function(){
  const c=document.getElementById('grid'),ctx=c.getContext('2d');
  function resize(){c.width=innerWidth;c.height=innerHeight;draw()}
  function draw(){
    ctx.clearRect(0,0,c.width,c.height);
    ctx.strokeStyle='rgba(0,255,159,0.03)';ctx.lineWidth=1;
    const s=60;
    for(let x=0;x<c.width;x+=s){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,c.height);ctx.stroke()}
    for(let y=0;y<c.height;y+=s){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(c.width,y);ctx.stroke()}
    const g=ctx.createRadialGradient(c.width/2,0,0,c.width/2,0,c.height*.6);
    g.addColorStop(0,'rgba(0,255,159,0.04)');g.addColorStop(1,'transparent');
    ctx.fillStyle=g;ctx.fillRect(0,0,c.width,c.height);
  }
  addEventListener('resize',resize);resize();
})();

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

// Animate a number with ticker effect
function tickerHtml(value, suffix) {
  const str = String(value);
  let html = '';
  for (let i = 0; i < str.length; i++) {
    const delay = (i * 60) + 'ms';
    html += '<span class="ticker-digit" style="animation-delay:' + delay + '">' + esc(str[i]) + '</span>';
  }
  if (suffix) html += '<span class="ticker-digit dim" style="animation-delay:' + (str.length * 60) + 'ms">' + esc(suffix) + '</span>';
  return '<span class="ticker">' + html + '</span>';
}

const CAP_LABELS = {
  database_api: 'Database API',
  file_storage: 'File Storage',
  static_hosting: 'Static Hosting',
  x402_payments: 'x402 Payments',
  allowance_billing: 'Allowance Billing',
  image_generation: 'Image Generation',
  testnet_faucet: 'Testnet Faucet'
};

function renderUptime(key, data) {
  if (!data) return;
  const el = document.getElementById('pct-' + key);
  const bar = document.getElementById('bar-' + key);
  const probes = document.getElementById('probes-' + key);
  const card = document.getElementById('up-' + key);

  el.innerHTML = tickerHtml(data.uptime_pct.toFixed(2), '%');
  bar.style.width = data.uptime_pct + '%';
  bar.style.background = data.uptime_pct >= 99.9 ? '#00FF9F' : data.uptime_pct >= 99 ? '#FBBF24' : '#FF5050';
  probes.textContent = data.healthy_probes.toLocaleString() + ' / ' + data.total_probes.toLocaleString() + ' probes';
  card.classList.add('loaded');
}

function renderCapabilities(perCap) {
  const grid = document.getElementById('cap-grid');
  const card = document.getElementById('cap-card');
  let html = '';
  let i = 0;
  for (const [key, pct] of Object.entries(perCap)) {
    const label = CAP_LABELS[key] || key;
    const cls = pct >= 99.9 ? '' : pct >= 99 ? ' warn' : ' bad';
    html += '<div class="cap-item" style="animation-delay:' + (i * 80) + 'ms">'
      + '<span class="cap-name">' + esc(label) + '</span>'
      + '<span class="cap-pct' + cls + '">' + pct.toFixed(2) + '%</span>'
      + '</div>';
    i++;
  }
  grid.innerHTML = html;
  card.style.display = '';
}

// Fetch status JSON from static site
async function loadUptime() {
  try {
    const r = await fetch('/status');
    const d = await r.json();
    if (d.availability) {
      renderUptime('24h', d.availability.last_24h);
      renderUptime('7d', d.availability.last_7d);
      renderUptime('30d', d.availability.last_30d);
      if (d.availability.last_30d && d.availability.last_30d.per_capability) {
        renderCapabilities(d.availability.last_30d.per_capability);
      }
    }
  } catch(e) { /* uptime section stays in placeholder state */ }
}

// Health check
async function check(){
  const t0=performance.now();
  try{
    const r=await fetch('/health');
    const ms=Math.round(performance.now()-t0);
    const d=await r.json();
    const ok=d.status==='healthy';

    document.getElementById('version').innerHTML='<span class="g">'+esc(d.version)+'</span>';
    document.getElementById('overall').innerHTML=
      '<span class="pulse-ring '+(ok?'ok':'err')+'"></span> '+(ok?'Operational':'Degraded');
    document.getElementById('main-pill').className='pill '+(ok?'ok':'err');
    document.getElementById('main-pill').textContent=ok?'ALL SYSTEMS GO':'DEGRADED';
    document.getElementById('main-card').className='card '+(ok?'ok':'err');

    const checksEl=document.getElementById('checks');
    const services=[
      {name:'Gateway API',status:'ok',ms:ms+'ms'},
      {name:'PostgreSQL (Aurora)',status:d.checks.postgres,ms:d.checks.postgres==='ok'?ms+'ms':'error'},
      {name:'PostgREST',status:d.checks.postgrest,ms:d.checks.postgrest==='ok'?ms+'ms':'error'},
      {name:'Cloud Object Storage',status:d.checks.s3||'ok',ms:d.checks.s3==='ok'?ms+'ms':(d.checks.s3?'error':'\\u2014')},
      {name:'Content Delivery Network',status:d.checks.cloudfront||'ok',ms:d.checks.cloudfront==='ok'?ms+'ms':(d.checks.cloudfront?'error':'\\u2014')},
    ];
    checksEl.innerHTML=services.map(function(s){
      return '<div class="check"><span class="check-name"><span class="check-dot '
        +(s.status==='ok'?'ok':'err')+'"></span> '+esc(s.name)+'</span><span class="check-ms">'
        +esc(s.ms)+'</span></div>';
    }).join('');

    document.getElementById('timestamp').textContent='Last checked: '+new Date().toLocaleString();
  }catch(e){
    document.getElementById('overall').innerHTML='<span class="pulse-ring err"></span> Unreachable';
    document.getElementById('main-pill').className='pill err';
    document.getElementById('main-pill').textContent='UNREACHABLE';
    document.getElementById('main-card').className='card err';
    document.getElementById('timestamp').textContent='Failed at '+new Date().toLocaleString();
  }
}

check();
loadUptime();
setInterval(check, 30000);
setInterval(loadUptime, 60000);
</script>
</body>
</html>`;
}

// --- Startup ---
let server: ReturnType<typeof app.listen>;
let oauthCleanupInterval: ReturnType<typeof setInterval> | null = null;

async function initDatabase() {
  // Check if internal schema already exists
  const result = await pool.query(
    sql(`SELECT 1 FROM information_schema.schemata WHERE schema_name = 'internal'`),
  );
  if (result.rows.length > 0) {
    console.log("  Database already initialized");
    return;
  }

  console.log("  Initializing database (first run)...");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const sqlPath = join(__dirname, "db", "init.sql");
  const initSql = readFileSync(sqlPath, "utf-8");

  const client = await pool.connect();
  try {
    await client.query(sql(initSql));
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
    sql(`SELECT schema_name FROM information_schema.schemata WHERE schema_name ~ '^p\\d{4}$'`),
  );
  if (result.rows.length > 0) {
    const client = await pool.connect();
    try {
      for (const row of result.rows) {
        const slot = row.schema_name;
        await client.query(
          sql(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${slot} GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role`),
        );
      }
      console.log(`  Applied sequence grants to ${result.rows.length} schema slots`);
    } finally {
      client.release();
    }
  }

  // v1.2: wallet_address for subscription linking
  await pool.query(sql(`ALTER TABLE internal.projects ADD COLUMN IF NOT EXISTS wallet_address TEXT`));
  await pool.query(sql(`CREATE INDEX IF NOT EXISTS idx_projects_wallet ON internal.projects(wallet_address) WHERE wallet_address IS NOT NULL`));

  // v1.3: pinned projects (lease never expires)
  await pool.query(sql(`ALTER TABLE internal.projects ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false`));

  // v1.4: function source storage (for publish/fork)
  // Guard: table created by initFunctionsTable(), may not exist on fresh DB
  const fnExists = await pool.query(sql(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'internal' AND table_name = 'functions'`));
  if (fnExists.rows.length > 0) {
    await pool.query(sql(`ALTER TABLE internal.functions ADD COLUMN IF NOT EXISTS source TEXT`));
  }

  // v1.5: deployment ref_count (for publish pinning)
  // Guard: table created by initDeploymentsTable(), may not exist on fresh DB
  const deplExists = await pool.query(sql(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'internal' AND table_name = 'deployments'`));
  if (deplExists.rows.length > 0) {
    await pool.query(sql(`ALTER TABLE internal.deployments ADD COLUMN IF NOT EXISTS ref_count INTEGER NOT NULL DEFAULT 0`));
  }

  // v1.6: fork provenance
  await pool.query(sql(`ALTER TABLE internal.projects ADD COLUMN IF NOT EXISTS source_version_id TEXT`));

  // v1.7: app version tags
  // Guard: table created by initAppVersionsTables(), may not exist on fresh DB
  const avExists = await pool.query(sql(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'internal' AND table_name = 'app_versions'`));
  if (avExists.rows.length > 0) {
    await pool.query(sql(`ALTER TABLE internal.app_versions ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'`));
    await pool.query(sql(`ALTER TABLE internal.app_versions ADD COLUMN IF NOT EXISTS live_url TEXT`));
  }

  // v1.8: ad attribution tracking (gclid + UTM beacons from landing pages)
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.ad_attribution (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      gclid TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_term TEXT,
      utm_content TEXT,
      page TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));
  await pool.query(sql(`CREATE INDEX IF NOT EXISTS idx_ad_attribution_time ON internal.ad_attribution(created_at DESC)`));
  await pool.query(sql(`CREATE INDEX IF NOT EXISTS idx_ad_attribution_gclid ON internal.ad_attribution(gclid) WHERE gclid IS NOT NULL`));

  // v1.9: billing/allowance tables
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.billing_accounts (
      id UUID PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      currency TEXT NOT NULL DEFAULT 'USD',
      available_usd_micros BIGINT NOT NULL DEFAULT 0,
      held_usd_micros BIGINT NOT NULL DEFAULT 0,
      funding_policy TEXT NOT NULL DEFAULT 'allowance_then_wallet',
      low_balance_threshold_usd_micros BIGINT NOT NULL DEFAULT 1000000,
      primary_contact_email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.billing_account_wallets (
      wallet_address TEXT PRIMARY KEY,
      billing_account_id UUID NOT NULL REFERENCES internal.billing_accounts(id),
      status TEXT NOT NULL DEFAULT 'active',
      role TEXT NOT NULL DEFAULT 'owner',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));
  await pool.query(sql(`CREATE INDEX IF NOT EXISTS idx_baw_account ON internal.billing_account_wallets(billing_account_id)`));
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.allowance_ledger (
      id UUID PRIMARY KEY,
      billing_account_id UUID NOT NULL REFERENCES internal.billing_accounts(id),
      direction TEXT NOT NULL,
      kind TEXT NOT NULL,
      amount_usd_micros BIGINT NOT NULL,
      balance_after_available BIGINT NOT NULL,
      balance_after_held BIGINT NOT NULL,
      reference_type TEXT,
      reference_id TEXT,
      idempotency_key TEXT UNIQUE,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));
  await pool.query(sql(`CREATE INDEX IF NOT EXISTS idx_ledger_account_time ON internal.allowance_ledger(billing_account_id, created_at DESC)`));
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.billing_topups (
      id UUID PRIMARY KEY,
      billing_account_id UUID NOT NULL REFERENCES internal.billing_accounts(id),
      wallet_address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'initiated',
      funded_usd_micros BIGINT NOT NULL,
      charged_usd_cents INTEGER NOT NULL,
      stripe_checkout_session_id TEXT UNIQUE,
      stripe_payment_intent_id TEXT UNIQUE,
      payer_email TEXT,
      terms_version TEXT,
      livemode BOOLEAN NOT NULL DEFAULT false,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ,
      credited_at TIMESTAMPTZ
    )
  `));
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.charge_authorizations (
      id UUID PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      billing_account_id UUID NOT NULL REFERENCES internal.billing_accounts(id),
      rail TEXT NOT NULL,
      sku TEXT NOT NULL,
      amount_usd_micros BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'captured',
      idempotency_key TEXT UNIQUE,
      payment_header_hash TEXT,
      metadata JSONB,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      captured_at TIMESTAMPTZ
    )
  `));
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.stripe_webhook_events (
      stripe_event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      livemode BOOLEAN NOT NULL DEFAULT false,
      payload JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      processing_error TEXT
    )
  `));

  // v1.11: wallet sightings — track every unique wallet encountered
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.wallet_sightings (
      wallet_address TEXT PRIMARY KEY,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source TEXT NOT NULL DEFAULT 'unknown'
    )
  `));

  // v1.12: faucet balance snapshots — track treasury balance over time
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.faucet_snapshots (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      balance_usdc NUMERIC(20,6) NOT NULL,
      event TEXT NOT NULL DEFAULT 'drip'
    )
  `));
  await pool.query(sql(`CREATE INDEX IF NOT EXISTS idx_faucet_snapshots_at ON internal.faucet_snapshots (recorded_at)`));

  // v1.13: agent contact info
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.agent_contacts (
      wallet_address TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      webhook TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));

  // v1.14: wallet-level tier subscription (pay-per-tier)
  await pool.query(sql(`ALTER TABLE internal.billing_accounts ADD COLUMN IF NOT EXISTS tier TEXT`));
  await pool.query(sql(`ALTER TABLE internal.billing_accounts ADD COLUMN IF NOT EXISTS lease_started_at TIMESTAMPTZ`));
  await pool.query(sql(`ALTER TABLE internal.billing_accounts ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`));

  // v1.10: demo mode columns
  await pool.query(sql(`ALTER TABLE internal.projects ADD COLUMN IF NOT EXISTS demo_mode BOOLEAN NOT NULL DEFAULT false`));
  await pool.query(sql(`ALTER TABLE internal.projects ADD COLUMN IF NOT EXISTS demo_config JSONB`));
  await pool.query(sql(`ALTER TABLE internal.projects ADD COLUMN IF NOT EXISTS demo_source_version_id TEXT`));
  await pool.query(sql(`ALTER TABLE internal.projects ADD COLUMN IF NOT EXISTS demo_last_reset_at TIMESTAMPTZ`));

  // v1.15: Google OAuth social login for app users
  // v1.15a: nullable password_hash (social-only users)
  await pool.query(sql(`ALTER TABLE internal.users ALTER COLUMN password_hash DROP NOT NULL`));

  // v1.15b: new user profile columns
  await pool.query(sql(`ALTER TABLE internal.users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ`));
  await pool.query(sql(`ALTER TABLE internal.users ADD COLUMN IF NOT EXISTS display_name TEXT`));
  await pool.query(sql(`ALTER TABLE internal.users ADD COLUMN IF NOT EXISTS avatar_url TEXT`));
  await pool.query(sql(`ALTER TABLE internal.users ADD COLUMN IF NOT EXISTS last_sign_in_at TIMESTAMPTZ`));

  // v1.15c: case-insensitive email uniqueness
  await pool.query(sql(`UPDATE internal.users SET email = LOWER(email) WHERE email != LOWER(email)`));
  await pool.query(sql(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_project_email_ci ON internal.users(project_id, LOWER(email))`));

  // v1.15d: auth identities (Google sub → project user)
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.auth_identities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES internal.users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_sub TEXT NOT NULL,
      provider_email TEXT,
      provider_data JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(project_id, provider, provider_sub)
    )
  `));
  await pool.query(sql(`CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON internal.auth_identities(user_id)`));

  // v1.15e: OAuth transactions (DB-backed state, replaces cookies)
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.oauth_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      state_hash TEXT NOT NULL UNIQUE,
      code_challenge TEXT,
      code_challenge_method TEXT,
      redirect_url TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'popup',
      intent TEXT NOT NULL DEFAULT 'signin',
      nonce TEXT NOT NULL,
      linking_user_id UUID,
      client_state TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));
  await pool.query(sql(`CREATE INDEX IF NOT EXISTS idx_oauth_tx_expires ON internal.oauth_transactions(expires_at)`));

  // v1.15f: OAuth codes (one-time auth codes, store hash only)
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.oauth_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code_hash TEXT NOT NULL UNIQUE,
      code_challenge TEXT,
      code_challenge_method TEXT DEFAULT 'S256',
      user_id UUID NOT NULL REFERENCES internal.users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      redirect_url TEXT NOT NULL,
      client_state TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));
  await pool.query(sql(`CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON internal.oauth_codes(expires_at)`));
}

async function start() {
  // Verify Postgres connection
  try {
    await pool.query(sql("SELECT 1 AS ok"));
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

  // Initialize admin wallets table
  await initAdminWalletsTable();

  // Initialize app versions tables (publish/fork)
  await initAppVersionsTables();

  // Initialize mailbox tables (email)
  await initMailboxTables();

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
  startDemoResetChecker();
  oauthCleanupInterval = setInterval(cleanupExpiredOAuthData, 3600_000);

  server = app.listen(PORT, () => {
    console.log(`\nAgentDB Gateway running on port ${PORT}`);
    console.log(`  Seller wallet:  ${SELLER_ADDRESS || "(not set — x402 disabled)"}`);
    console.log(`  Networks:       ${MAINNET_NETWORK} (mainnet), ${TESTNET_NETWORK} (testnet)`);
    console.log(`  Facilitator:    ${FACILITATOR_PROVIDER}${FACILITATOR_PROVIDER === "stripe" ? "" : (CDP_API_KEY_ID ? "" : " — NO KEY, x402 will fail")}`);
    console.log(`  PostgREST:      ${POSTGREST_URL}`);
    console.log(`  Functions:      ${LAMBDA_ROLE_ARN ? "Lambda" : "local (no LAMBDA_ROLE_ARN — functions run in-process)"}`);
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
  stopDemoResetChecker();
  if (oauthCleanupInterval) clearInterval(oauthCleanupInterval);

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
