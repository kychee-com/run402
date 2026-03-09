import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});
const BUCKET = process.env.SITE_BUCKET;
const STATUS_KEY = process.env.STATUS_KEY || "status/v1.json";
const HISTORY_PREFIX = process.env.HISTORY_PREFIX || "status/history/";
const API_BASE = "https://api.run402.com";

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function probe(url, { expectStatus = 200, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const start = Date.now();
    const res = await fetch(url, { signal: controller.signal });
    const latencyMs = Date.now() - start;
    return { status: res.status, ok: res.status === expectStatus, body: await res.json().catch(() => null), latencyMs };
  } catch (err) {
    return { status: 0, ok: false, body: null, latencyMs: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function runProbes() {
  const [health, ping, billing] = await Promise.all([
    probe(`${API_BASE}/health`),
    probe(`${API_BASE}/v1/ping`, { expectStatus: 402 }),
    probe(`${API_BASE}/v1/billing/accounts/0x0000000000000000000000000000000000000000`),
  ]);

  const checks = health.body?.checks || {};

  const caps = {
    database_api: checks.postgres === "ok" && checks.postgrest === "ok",
    file_storage: checks.s3 === "ok",
    static_hosting: checks.cloudfront === "ok",
    x402_payments: ping.ok,
    allowance_billing: billing.ok,
    image_generation: health.ok,
    testnet_faucet: health.ok,
  };

  return { caps, health, ping, billing };
}

// ---------------------------------------------------------------------------
// S3 helpers
// ---------------------------------------------------------------------------

async function readJson(key) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function writeJson(key, data, cacheControl) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(data, null, 2),
    ContentType: "application/json",
    ...(cacheControl && { CacheControl: cacheControl }),
  }));
}

// ---------------------------------------------------------------------------
// History management (monthly files)
// ---------------------------------------------------------------------------

function monthKey(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${HISTORY_PREFIX}${y}-${m}.json`;
}

function monthsBack(n) {
  const keys = [];
  const now = new Date();
  for (let i = 0; i <= n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(monthKey(d));
  }
  return keys;
}

async function appendHistory(entry) {
  const key = monthKey(new Date(entry.t));
  const history = (await readJson(key)) || [];
  history.push(entry);
  await writeJson(key, history);
  return key;
}

async function loadHistory(months) {
  const keys = monthsBack(months);
  const files = await Promise.all(keys.map(k => readJson(k)));
  const all = [];
  for (const f of files) {
    if (f) all.push(...f);
  }
  return all;
}

// ---------------------------------------------------------------------------
// Uptime computation
// ---------------------------------------------------------------------------

function computeUptime(entries, windowMs) {
  const cutoff = Date.now() - windowMs;
  const window = entries.filter(e => new Date(e.t).getTime() >= cutoff);
  if (window.length === 0) return null;

  // Overall: database_api AND x402_payments
  const overallUp = window.filter(e => e.caps.database_api && e.caps.x402_payments).length;

  // Per-capability
  const capNames = Object.keys(window[0]?.caps || {});
  const perCap = {};
  for (const cap of capNames) {
    const up = window.filter(e => e.caps[cap]).length;
    perCap[cap] = round(up / window.length * 100);
  }

  return {
    uptime_pct: round(overallUp / window.length * 100),
    total_probes: window.length,
    healthy_probes: overallUp,
    per_capability: perCap,
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Build status/v1.json
// ---------------------------------------------------------------------------

function buildStatus(caps, availability) {
  const capStatuses = {};
  for (const [k, v] of Object.entries(caps)) {
    capStatuses[k] = v ? "operational" : "degraded";
  }

  const overallOk = caps.database_api && caps.x402_payments;

  return {
    schema_version: "run402-status-v1",
    generated_at: new Date().toISOString(),
    service: "Run402",
    operator: {
      legal_name: "Kychee LLC",
      terms_url: "https://run402.com/humans/terms.html",
      contact: "POST /v1/message ($0.01 x402)",
    },
    current_status: overallOk ? "operational" : "degraded",
    public_history_start: "2026-02-15T00:00:00Z",
    availability_objective: {
      scope: "core_api_capabilities",
      monthly_target_pct: 99.9,
      contractual_sla: false,
      note: "Operational objective, not contractual SLA",
    },
    monitoring: {
      external_probes: true,
      probe_interval_seconds: 60,
      billable_402_counts_as_healthy: true,
      methodology: "External HTTP probes to /health plus internal component checks",
    },
    availability,
    deployment: {
      cloud: "AWS",
      region: "us-east-1",
      topology: "single-region, multi-AZ (2 AZs)",
      multi_region_failover: false,
      database: "Aurora PostgreSQL Serverless v2 (Postgres 16), multi-AZ failover",
      compute: "ECS Fargate behind Application Load Balancer",
      storage: "Amazon S3",
      cdn: "Amazon CloudFront + S3",
      iac: "AWS CDK",
      backup_retention_days: 7,
      encryption_at_rest: true,
      tls_in_transit: true,
    },
    capabilities: capStatuses,
    links: {
      health: "https://api.run402.com/health",
      health_humans: "https://api.run402.com/health-humans",
      llms: "https://run402.com/llms.txt",
      terms: "https://run402.com/humans/terms.html",
      privacy: "https://run402.com/humans/privacy.html",
    },
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const MS_24H = 24 * 60 * 60 * 1000;
const MS_7D = 7 * MS_24H;
const MS_30D = 30 * MS_24H;

export async function handler() {
  const { caps } = await runProbes();

  const entry = {
    t: new Date().toISOString(),
    ok: caps.database_api && caps.x402_payments,
    caps,
  };

  // Append to current month's history file
  await appendHistory(entry);

  // Load up to 4 months of history (covers 90d rolling window)
  const history = await loadHistory(3);

  const availability = {
    last_24h: computeUptime(history, MS_24H),
    last_7d: computeUptime(history, MS_7D),
    last_30d: computeUptime(history, MS_30D),
  };

  const status = buildStatus(caps, availability);
  await writeJson(STATUS_KEY, status, "public, max-age=60");

  console.log(JSON.stringify({
    ok: entry.ok,
    caps,
    availability: {
      "24h": availability.last_24h?.uptime_pct,
      "7d": availability.last_7d?.uptime_pct,
      "30d": availability.last_30d?.uptime_pct,
    },
  }));

  return { statusCode: 200, body: "ok" };
}
