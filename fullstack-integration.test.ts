/**
 * fullstack-integration.test.ts — live Run402 platform coverage.
 *
 * NO MOCKS. This suite provisions a temporary project, deploys a representative
 * full-stack release, verifies it over HTTP/API calls, and tears it down.
 *
 * Prerequisites:
 *   - Run `npm run build` first, or use `npm run test:integration:fullstack`.
 *   - Set BUYER_PRIVATE_KEY, or keep it in ../run402-private/.env.
 *   - Optional: set RUN402_FULLSTACK_EMAIL_TO to an approved test recipient.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(ROOT, "integration-fixtures", "fullstack-app");
const SITE_DIR = join(FIXTURE_DIR, "site");
const FUNCTIONS_DIR = join(FIXTURE_DIR, "functions");
const SQL_DIR = join(FIXTURE_DIR, "sql");
const API =
  process.env.RUN402_FULLSTACK_API_BASE ??
  process.env.RUN402_API_BASE ??
  "https://api.run402.com";
const EMAIL_TO = process.env.RUN402_FULLSTACK_EMAIL_TO;
const EMAIL_TEMPLATE = process.env.RUN402_FULLSTACK_EMAIL_TEMPLATE;
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const SUBDOMAIN = `fs-${RUN_ID}`;
const TEST_SECRET_VALUE = `fullstack-secret-${RUN_ID}`;

const originalEnv = new Map<string, string | undefined>();
for (const key of ["RUN402_CONFIG_DIR", "RUN402_API_BASE"]) {
  originalEnv.set(key, process.env[key]);
}

let tempDir = "";
let r: any;
let sdkModule: any;
let projectId = "";
let anonKey = "";
let serviceKey = "";
let mailboxId = "";
let publicBase = "";
let routeBase = "";
let initialSpec: Record<string, unknown>;
let firstReleaseId = "";
let changedReleaseId = "";
let accessToken = "";
let authUserEmail = "";
let authUserId = "";
const cleanupErrors: string[] = [];
const createdBlobKeys = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readFixture(rel: string): string {
  return readFileSync(join(FIXTURE_DIR, rel), "utf-8");
}

function readFunction(name: string): string {
  return readFileSync(join(FUNCTIONS_DIR, name), "utf-8");
}

function migrationSql(): string {
  return `${readFileSync(join(SQL_DIR, "schema.sql"), "utf-8")}\n${readFileSync(join(SQL_DIR, "seed.sql"), "utf-8")}`;
}

function exposeManifest(): Record<string, unknown> {
  return {
    version: "1",
    tables: [
      { name: "fs_accounts", expose: true, policy: "public_read_authenticated_write" },
      { name: "fs_items", expose: true, policy: "public_read_authenticated_write" },
    ],
    views: [],
    rpcs: [],
  };
}

async function buildInitialSpec(): Promise<Record<string, unknown>> {
  const siteFiles = await sdkModule.fileSetFromDir(SITE_DIR);
  siteFiles["runtime/generated.json"] = JSON.stringify({
    fixture: "run402-fullstack",
    runId: RUN_ID,
    marker: "RUN402_FULLSTACK_GENERATED_CONFIG_MARKER",
  });

  return {
    project: projectId,
    database: {
      migrations: [{ id: "fullstack_integration_001", sql: migrationSql() }],
      expose: exposeManifest(),
    },
    secrets: { require: ["FULLSTACK_TEST_SECRET"] },
    functions: {
      replace: {
        "fullstack-direct": {
          runtime: "node22",
          source: readFunction("fullstack-direct.mjs"),
          config: { timeoutSeconds: 45, memoryMb: 512 },
        },
        "fullstack-public": {
          runtime: "node22",
          source: readFunction("fullstack-public.mjs"),
          config: { timeoutSeconds: 30, memoryMb: 256 },
        },
        "fullstack-scheduled": {
          runtime: "node22",
          source: readFunction("fullstack-scheduled.mjs"),
          config: { timeoutSeconds: 30, memoryMb: 256 },
          schedule: "0 0 1 1 *",
        },
      },
    },
    site: { replace: siteFiles },
    subdomains: { set: [SUBDOMAIN] },
    routes: {
      replace: [
        { pattern: "/readme", methods: ["GET", "HEAD"], target: { type: "static", file: "docs.html" } },
        { pattern: "/api/fullstack", methods: ["POST", "OPTIONS"], target: { type: "function", name: "fullstack-public" } },
      ],
    },
  };
}

function buildChangedSpec(): Record<string, unknown> {
  return {
    project: projectId,
    site: {
      patch: {
        put: {
          "version.txt": `RUN402_FULLSTACK_VERSION_MARKER=v2\nrun_id=${RUN_ID}\n`,
        },
      },
    },
  };
}

function rowsFromSql(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (result && typeof result === "object") {
    const maybeRows = (result as { rows?: unknown }).rows;
    if (Array.isArray(maybeRows)) return maybeRows as Array<Record<string, unknown>>;
  }
  throw new Error(`Unexpected SQL result shape: ${JSON.stringify(result)}`);
}

function choosePublicBase(urls: Record<string, string>): string {
  const all = Object.values(urls).filter((value): value is string => typeof value === "string" && value.startsWith("http"));
  const exact = all.find((url) => url.includes(`${SUBDOMAIN}.run402.com`));
  const preferred = urls.site_url ?? urls.site ?? urls.default ?? all[0] ?? exact ?? `https://${SUBDOMAIN}.run402.com`;
  return preferred.replace(/\/+$/, "");
}

function publicBaseCandidates(urls: Record<string, string>): string[] {
  const out = new Set<string>();
  const httpUrls = Object.values(urls).filter((value): value is string => typeof value === "string" && value.startsWith("http"));
  for (const url of httpUrls.filter((value) => value.includes("sites.run402.com"))) out.add(url.replace(/\/+$/, ""));
  for (const [key, value] of Object.entries(urls)) {
    if (/deployment/i.test(key) && typeof value === "string" && value.startsWith("dpl_")) {
      out.add(`https://${value.replace(/_/g, "-")}.sites.run402.com`);
    }
  }
  for (const url of httpUrls.filter((value) => !value.includes(`${SUBDOMAIN}.run402.com`))) out.add(url.replace(/\/+$/, ""));
  for (const url of httpUrls) out.add(url.replace(/\/+$/, ""));
  out.add(`https://${SUBDOMAIN}.run402.com`);
  return [...out];
}

async function chooseWorkingPublicBase(urls: Record<string, string>): Promise<string> {
  const candidates = publicBaseCandidates(urls);
  return eventually("public base selection", async () => {
    for (const candidate of candidates) {
      try {
        const res = await fetch(`${candidate}/css/app.css`, { headers: { "cache-control": "no-cache" } });
        const text = await res.text();
        if (res.status === 200 && text.includes("RUN402_FULLSTACK_ASSET_MARKER")) return candidate;
      } catch {
        // Try the next candidate during this poll.
      }
    }
    throw new Error(`no candidate served static assets: ${candidates.join(", ")}`);
  }, { attempts: 18, delayMs: 2_500 });
}

async function eventually<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 12;
  const delayMs = opts.delayMs ?? 2_500;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw new Error(`${label} did not become ready: ${last instanceof Error ? last.message : String(last)}`);
}

async function fetchTextOk(pathOrUrl: string): Promise<string> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${publicBase}${pathOrUrl}`;
  return eventually(`GET ${url}`, async () => {
    const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
    const text = await res.text();
    assert.equal(res.status, 200, `GET ${url} returned ${res.status}: ${text.slice(0, 300)}`);
    return text;
  });
}

async function fetchTextOkAt(base: string, path: string): Promise<string> {
  return eventually(`GET ${base}${path}`, async () => {
    const res = await fetch(`${base}${path}`, { headers: { "cache-control": "no-cache" } });
    const text = await res.text();
    assert.equal(res.status, 200, `GET ${base}${path} returned ${res.status}: ${text.slice(0, 300)}`);
    return text;
  }, { attempts: 18, delayMs: 2_500 });
}

async function fetchJsonOk(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  return eventually(`fetch ${url}`, async () => {
    const res = await fetch(url, init);
    const text = await res.text();
    assert.equal(res.status, 200, `${init.method ?? "GET"} ${url} returned ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as Record<string, unknown>;
  });
}

function assertNoStaticFallbackForUnsupportedRouteMethod(
  status: number,
  text: string,
): void {
  assert.ok(
    [404, 405].includes(status),
    `GET /api/fullstack should be rejected by route/method handling, got ${status}: ${text.slice(0, 300)}`,
  );
  const forbiddenStaticMarkers = [
    "RUN402_FULLSTACK_INDEX_MARKER",
    "RUN402_FULLSTACK_DOCS_MARKER",
    "RUN402_FULLSTACK_STATUS_MARKER",
    "RUN402_FULLSTACK_RUNTIME_CONFIG_MARKER",
    "RUN402_FULLSTACK_DISCOVERY_MARKER",
  ];
  for (const marker of forbiddenStaticMarkers) {
    assert.equal(
      text.includes(marker),
      false,
      `unsupported GET /api/fullstack fell through to unrelated static content marker ${marker}`,
    );
  }
}

async function directFunctionFetch(
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
    body = JSON.stringify(init.body);
  }
  return fetch(`${API}/functions/v1/fullstack-direct`, { method, headers, body });
}

async function directFunctionJson(
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<Record<string, unknown>> {
  return eventually("direct function invocation", async () => {
    const res = await directFunctionFetch(init);
    const text = await res.text();
    assert.equal(res.status, 200, `direct function returned ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as Record<string, unknown>;
  });
}

function apiHeaders(kind: "anon" | "service", extra: Record<string, string> = {}): Record<string, string> {
  const key = kind === "anon" ? anonKey : serviceKey;
  return { apikey: key, ...extra };
}

function readEnvPrivateKey(): string | undefined {
  if (process.env.BUYER_PRIVATE_KEY) return process.env.BUYER_PRIVATE_KEY.trim();
  const searchPaths = [
    join(ROOT, "..", "run402-private", ".env"),
    join(ROOT, "..", "run402", ".env"),
  ];
  for (const envPath of searchPaths) {
    if (!existsSync(envPath)) continue;
    const envContent = readFileSync(envPath, "utf-8");
    const match = envContent.match(/(?:^|\n)\s*(?:export\s+)?BUYER_PRIVATE_KEY\s*=\s*("?)([^"\n]+)\1/);
    if (match?.[2]) return match[2].trim();
  }
  return undefined;
}

function assertHasMissingSecretWarning(plan: unknown): void {
  const warnings = (plan && typeof plan === "object" ? (plan as { warnings?: unknown }).warnings : undefined) ?? [];
  assert.ok(Array.isArray(warnings), "plan warnings should be an array");
  assert.ok(
    warnings.some((warning) => {
      const text = JSON.stringify(warning);
      return text.includes("MISSING_REQUIRED_SECRET") || text.includes("FULLSTACK_TEST_SECRET");
    }),
    `expected missing secret warning, got ${JSON.stringify(warnings)}`,
  );
}

function assertInventory(name: string, inventory: Record<string, any>): void {
  const sitePaths = new Set((inventory.site?.paths ?? []).map((entry: any) => entry.path));
  assert.ok(sitePaths.has("index.html"), `${name} inventory should include index.html`);
  assert.ok(sitePaths.has("docs.html"), `${name} inventory should include docs.html`);

  const functions = new Map((inventory.functions ?? []).map((entry: any) => [entry.name, entry]));
  assert.ok(functions.has("fullstack-direct"), `${name} inventory should include direct function`);
  assert.ok(functions.has("fullstack-public"), `${name} inventory should include routed function`);
  assert.equal(functions.get("fullstack-scheduled")?.schedule, "0 0 1 1 *");

  assert.ok((inventory.subdomains?.names ?? []).includes(SUBDOMAIN), `${name} inventory should include subdomain`);
  const routes = inventory.routes?.entries ?? [];
  assert.ok(routes.some((route: any) => route.pattern === "/readme" && route.target?.type === "static"));
  assert.ok(routes.some((route: any) => route.pattern === "/api/fullstack" && route.target?.name === "fullstack-public"));
  assert.ok((inventory.migrations_applied ?? []).some((migration: any) => migration.migration_id === "fullstack_integration_001"));
}

function assertNoopLike(result: Record<string, any>): void {
  const diff = result.diff ?? {};
  const migrations = diff.migrations ?? {};
  assert.equal((migrations.new ?? []).length, 0, "unchanged deploy should not add migrations");
  assert.equal((diff.functions?.added ?? []).length, 0, "unchanged deploy should not add functions");
  assert.equal((diff.functions?.changed ?? []).length, 0, "unchanged deploy should not change functions");
  assert.equal((diff.routes?.added ?? []).length, 0, "unchanged deploy should not add routes");
  assert.equal((diff.routes?.changed ?? []).length, 0, "unchanged deploy should not change routes");
}

async function removeBlobKey(key: string): Promise<void> {
  try {
    await r.assets.rm(projectId, key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("404") && !message.includes("not found")) throw err;
  }
}

before(async () => {
  // `@run402/functions` source lives in the public run402-core repo. The
  // fixture functions still import from `@run402/functions`, but Cloud
  // resolves and bundles its installed package gateway-side, not locally.
  const requiredBuilds = [
    join(ROOT, "core", "dist", "config.js"),
    join(ROOT, "sdk", "core-dist", "config.js"),
  ];
  const missingBuilds = requiredBuilds.filter((path) => !existsSync(path));
  if (missingBuilds.length > 0) {
    throw new Error(`Required build outputs are missing. Run npm run build first. Missing: ${missingBuilds.join(", ")}`);
  }

  const buyerKey = readEnvPrivateKey();
  if (!buyerKey) {
    throw new Error("BUYER_PRIVATE_KEY not found. Set env var or ensure ../run402-private/.env exists.");
  }

  tempDir = mkdtempSync(join(tmpdir(), "run402-fullstack-integ-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = API;

  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(buyerKey as `0x${string}`);
  writeFileSync(
    join(tempDir, "allowance.json"),
    JSON.stringify({
      address: account.address,
      privateKey: buyerKey,
      created: new Date().toISOString(),
      funded: true,
    }),
    { mode: 0o600 },
  );

  sdkModule = await import("./sdk/src/node/index.ts");
  r = sdkModule.run402({ apiBase: API });

  // Tier-aware before-hook: provision at whichever tier the wallet is
  // currently active on. We try to set/refresh prototype (the minimal tier
  // the test fixtures fit into), but fall back to the existing tier if the
  // wallet is on hobby/team and the downgrade would exceed quota.
  let activeTier: string = "prototype";
  try {
    await r.tier.set("prototype");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("already active")) {
      // prototype is active; nothing to do
    } else if (message.includes("Cannot downgrade") || message.includes("exceeds new tier limits")) {
      // Wallet is on a higher tier with usage above prototype caps —
      // proceed at the current tier instead of downgrading.
      const status = await r.tier.status();
      if (status.tier && typeof status.tier === "string") {
        activeTier = status.tier;
        console.error(`[before] wallet on higher tier (${activeTier}); proceeding without downgrade`);
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  const project = await r.projects.provision({
    tier: activeTier as "prototype" | "hobby" | "team",
    name: `fullstack-integ-${RUN_ID}`,
  });
  projectId = project.project_id;
  anonKey = project.anon_key;
  serviceKey = project.service_key;

  const mailbox = await r.email.create(projectId, `fs-${RUN_ID}`.slice(0, 63));
  mailboxId = mailbox.mailbox_id;
});

after(async () => {
  if (r && projectId && createdBlobKeys.size > 0) {
    for (const key of Array.from(createdBlobKeys).reverse()) {
      try {
        await removeBlobKey(key);
      } catch (err) {
        cleanupErrors.push(`blob ${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (r && projectId && mailboxId) {
    try {
      await r.email.delete(projectId, mailboxId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("404") && !message.includes("not found")) {
        cleanupErrors.push(`mailbox ${mailboxId}: ${message}`);
      }
    }
  }

  if (r && projectId) {
    try {
      await r.projects.delete(projectId);
    } catch (err) {
      cleanupErrors.push(`project ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  if (cleanupErrors.length > 0) {
    console.error(`Full-stack cleanup completed with ${cleanupErrors.length} warning(s):\n${cleanupErrors.join("\n")}`);
  }
});

describe("Run402 full-stack integration (live API, no mocks)", { timeout: 900_000, concurrency: false }, () => {
  it("checks prerequisites and fixture neutrality", () => {
    assert.ok(API.startsWith("http"), `unexpected API base: ${API}`);
    assert.ok(tempDir.includes("run402-fullstack-integ-"));
    assert.ok(projectId.startsWith("prj_"));
    assert.ok(anonKey.length > 20);
    assert.ok(serviceKey.length > 20);
    assert.equal(readFixture("metadata.json").includes("run402-fullstack-integration-fixture"), true);
    assert.ok(EMAIL_TO === undefined || EMAIL_TO.includes("@"));
    assert.equal(process.env.RUN402_FULLSTACK_STICKY_DOMAIN ?? "", "");
  });

  it("plans missing required secrets, sets them, and deploys the representative release", async () => {
    initialSpec = await buildInitialSpec();

    const dryRun = await r._applyEngine.plan(initialSpec, { dryRun: true });
    assertHasMissingSecretWarning(dryRun.plan);

    await assert.rejects(
      r._applyEngine.apply(initialSpec, { maxRetries: 0 }),
      (err: unknown) => {
        const text = err instanceof Error ? err.message : JSON.stringify(err);
        return text.includes("MISSING_REQUIRED_SECRET") || text.includes("FULLSTACK_TEST_SECRET");
      },
    );

    await r.secrets.set(projectId, "FULLSTACK_TEST_SECRET", TEST_SECRET_VALUE);
    if (EMAIL_TO) await r.secrets.set(projectId, "FULLSTACK_EMAIL_TO", EMAIL_TO);
    const secretList = await r.secrets.list(projectId);
    assert.ok(secretList.secrets.some((secret: any) => secret.key === "FULLSTACK_TEST_SECRET"));

    const events: Array<Record<string, unknown>> = [];
    const result = await r._applyEngine.apply(initialSpec, {
      idempotencyKey: `fullstack-${RUN_ID}-initial`,
      onEvent: (event: Record<string, unknown>) => events.push(event),
    });

    firstReleaseId = result.release_id;
    publicBase = await chooseWorkingPublicBase(result.urls);
    routeBase = `https://${SUBDOMAIN}.run402.com`;
    assert.ok(result.release_id.startsWith("rel_"), `release id: ${result.release_id}`);
    assert.ok(result.operation_id.startsWith("op_"), `operation id: ${result.operation_id}`);
    assert.ok(publicBase.includes("run402.com"), `public base: ${publicBase}`);
    assert.ok(Object.values(result.urls).some((url) => String(url).includes(`${SUBDOMAIN}.run402.com`)));
    assert.ok(events.some((event) => event.type === "ready"), "deploy should emit ready");
  });

  it("verifies database schema, seed data, relational queries, and REST reads", async () => {
    const schema = await r.projects.schema(projectId);
    const tableNames = new Set(schema.tables.map((table: any) => table.name));
    assert.ok(tableNames.has("fs_accounts"));
    assert.ok(tableNames.has("fs_items"));
    assert.ok(tableNames.has("fs_runtime_events"));
    assert.ok(tableNames.has("fs_owned_notes"));

    const relation = rowsFromSql(await r.projects.sql(projectId, `
      SELECT a.slug, count(i.id)::int AS item_count
      FROM fs_accounts a
      JOIN fs_items i ON i.account_id = a.id
      GROUP BY a.slug
      ORDER BY a.slug
    `));
    assert.deepEqual(
      relation.map((row) => [row.slug, Number(row.item_count)]),
      [["alpha", 1], ["beta", 1]],
    );

    const restRows = await r.projects.rest(projectId, "fs_items", "select=marker,title,done&order=marker.asc");
    assert.ok(Array.isArray(restRows));
    assert.ok(restRows.some((row: any) => row.marker === "RUN402_FULLSTACK_SEED_ALPHA"));
  });

  it("fetches hosted static pages, assets, runtime config, and discovery files", async () => {
    assert.match(await fetchTextOk("/"), /RUN402_FULLSTACK_INDEX_MARKER/);
    assert.match(await fetchTextOk("/docs.html"), /RUN402_FULLSTACK_DOCS_MARKER/);
    assert.match(await fetchTextOk("/status.html"), /RUN402_FULLSTACK_STATUS_MARKER/);
    assert.match(await fetchTextOk("/css/app.css"), /RUN402_FULLSTACK_ASSET_MARKER/);
    assert.match(await fetchTextOk("/js/env.js"), /RUN402_FULLSTACK_JS_MARKER/);
    assert.match(await fetchTextOk("/runtime/config.json"), /RUN402_FULLSTACK_RUNTIME_CONFIG_MARKER/);
    assert.match(await fetchTextOk("/runtime/generated.json"), /RUN402_FULLSTACK_GENERATED_CONFIG_MARKER/);
    assert.match(await fetchTextOk("/.well-known/run402-fullstack.json"), /RUN402_FULLSTACK_DISCOVERY_MARKER/);
  });

  it("verifies static route aliases, deploy diagnostics, and method-scoped route failure", async () => {
    assert.match(await fetchTextOkAt(routeBase, "/readme"), /RUN402_FULLSTACK_DOCS_MARKER/);
    const resolved = await r._applyEngine.resolve({ project: projectId, url: `${routeBase}/readme`, method: "GET" });
    assert.equal(resolved.authorized, true);
    assert.equal(resolved.result, 200);

    const unsupported = await fetch(`${routeBase}/api/fullstack`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const text = await unsupported.text();
    assertNoStaticFallbackForUnsupportedRouteMethod(unsupported.status, text);
  });

  it("configures auth, creates a temporary user, and obtains a bearer token", async () => {
    await r.auth.settings(projectId, {
      allow_password_set: true,
      preferred_sign_in_method: "password",
      public_signup: "open",
    });

    authUserEmail = `fullstack-${RUN_ID}@example.com`;
    const password = `Run402-${RUN_ID}-password`;
    const signup = await fetch(`${API}/auth/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: anonKey },
      body: JSON.stringify({ email: authUserEmail, password }),
    });
    const signupText = await signup.text();
    assert.ok([200, 201, 409].includes(signup.status), `signup returned ${signup.status}: ${signupText}`);

    const login = await fetch(`${API}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: anonKey },
      body: JSON.stringify({ email: authUserEmail, password }),
    });
    const loginText = await login.text();
    assert.equal(login.status, 200, `login returned ${login.status}: ${loginText}`);
    const session = JSON.parse(loginText);
    accessToken = session.access_token;
    authUserId = session.user?.id;
    assert.ok(accessToken.length > 20);
    assert.equal(session.user?.email, authUserEmail);
    assert.ok(authUserId);
  });

  it("verifies direct function endpoint behavior for no key, anon key, service key, and user bearer", async () => {
    const noKey = await directFunctionFetch({ method: "GET" });
    assert.ok([401, 403].includes(noKey.status), `no-key direct function status ${noKey.status}`);

    const anon = await directFunctionJson({ headers: apiHeaders("anon") });
    assert.equal(anon.user, null);

    const service = await directFunctionJson({ headers: apiHeaders("service") });
    assert.equal(service.ok, true);

    const authed = await directFunctionJson({
      headers: apiHeaders("anon", { authorization: `Bearer ${accessToken}` }),
    });
    assert.equal((authed.user as Record<string, unknown>)?.email, authUserEmail);
    assert.equal((authed.user as Record<string, unknown>)?.id, authUserId);
  });

  it("invokes runtime helpers for admin DB, caller DB, getUser, and public routed HTTP", async () => {
    const admin = await directFunctionJson({
      headers: apiHeaders("service"),
      body: { action: "admin-db" },
    });
    const adminRows = rowsFromSql(admin.rows);
    assert.equal(adminRows[0]?.kind, "admin-db");
    assert.notEqual(adminRows[0]?.created_at, undefined);
    assert.notEqual(adminRows[0]?.updated_at, undefined);

    const anonymousCaller = await directFunctionJson({
      headers: apiHeaders("anon"),
      body: { action: "caller-db" },
    });
    assert.equal(anonymousCaller.authenticated, false);
    assert.equal(anonymousCaller.user, null);
    assert.ok(rowsFromSql(anonymousCaller.rows).some((row) => row.marker === "RUN402_FULLSTACK_SEED_ALPHA"));

    const authenticatedCaller = await directFunctionJson({
      headers: apiHeaders("anon", { authorization: `Bearer ${accessToken}` }),
      body: { action: "caller-db" },
    });
    assert.equal(authenticatedCaller.authenticated, true);
    assert.equal((authenticatedCaller.user as Record<string, unknown>)?.email, authUserEmail);

    const routed = await fetchJsonOk(`${routeBase}/api/fullstack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ marker: "RUN402_FULLSTACK_PUBLIC_ROUTE_ASSERTION" }),
    });
    assert.equal(routed.route, "fullstack-public");
    assert.equal(routed.path, "/api/fullstack");
    assert.equal(routed.marker, "RUN402_FULLSTACK_PUBLIC_ROUTE_ASSERTION");

    const options = await fetch(`${routeBase}/api/fullstack`, { method: "OPTIONS" });
    assert.equal(options.status, 204);

    // Gap 3: adminDb().from() — PostgREST /admin/v1/rest/* bypass path
    const adminFrom = await directFunctionJson({
      headers: apiHeaders("service"),
      body: { action: "admin-db-from" },
    });
    assert.equal(adminFrom.ok, true);
    const adminFromRows = rowsFromSql(adminFrom.rows);
    assert.ok(adminFromRows.length > 0, "adminDb().from() should return seeded rows");
    assert.ok(adminFromRows.some((row) => row.marker === "RUN402_FULLSTACK_SEED_ALPHA"), "adminDb().from() should see rows bypassing RLS");
  });

  it("uploads blobs, diagnoses CDN state, and exercises in-function storage", async () => {
    const sdkKey = `fullstack/sdk-${RUN_ID}.txt`;
    createdBlobKeys.add(sdkKey);
    const asset = await r.assets.put(projectId, sdkKey, "RUN402_FULLSTACK_BLOB_MARKER", {
      contentType: "text/plain; charset=utf-8",
    });
    const assetUrl = asset.cdnUrl ?? asset.immutableUrl ?? asset.url;
    assert.ok(assetUrl, "blob upload should return a retrievable URL");
    assert.match(await fetchTextOk(assetUrl), /RUN402_FULLSTACK_BLOB_MARKER/);

    const diagnose = await r.assets.diagnoseUrl(projectId, assetUrl);
    assert.ok(diagnose.key === sdkKey || diagnose.key.startsWith(`fullstack/sdk-${RUN_ID}-`));
    assert.equal(diagnose.expectedSha256, asset.contentSha256);

    const storage = await directFunctionJson({
      headers: apiHeaders("service"),
      body: { action: "storage" },
    });
    const functionAsset = (storage.asset ?? {}) as Record<string, string>;
    assert.equal(storage.status, "ok");
    assert.ok(functionAsset.key);
    createdBlobKeys.add(functionAsset.key);
    const url = functionAsset.cdnUrl ?? functionAsset.immutableUrl ?? functionAsset.url;
    assert.ok(url, "in-function upload must return a retrievable URL");
    assert.match(await fetchTextOk(url), /run402 function upload/);
  });

  it("preserves the old immutable URL after re-uploading the same key with new bytes (design D16)", async () => {
    // Re-uploading the same key with new bytes produces a new immutable URL
    // (with v2's SHA suffix) AND must leave the old immutable URL (with v1's
    // SHA suffix) serving v1's bytes for `asset_versions.retained_until` —
    // design D16. The gateway inserts a fresh `blob_url_refs` row at v2's
    // public_url_key without touching v1's row; the CDN-origin resolver finds
    // each by `(project_id, public_url_key)`.
    const key = `fullstack/retention-${RUN_ID}.txt`;
    createdBlobKeys.add(key);
    const v1 = await r.assets.put(projectId, key, "retention v1 marker", {
      contentType: "text/plain; charset=utf-8",
    });
    const v2 = await r.assets.put(projectId, key, "retention v2 marker", {
      contentType: "text/plain; charset=utf-8",
    });
    const v1Url = v1.cdnUrl ?? v1.immutableUrl;
    const v2Url = v2.cdnUrl ?? v2.immutableUrl;
    assert.ok(v1Url);
    assert.ok(v2Url);
    assert.notEqual(v1Url, v2Url);
    assert.match(await fetchTextOk(v2Url), /retention v2 marker/);
    assert.match(await fetchTextOk(v1Url), /retention v1 marker/);
  });

  it("(v1.49 image variants) JPEG upload returns variants + dimensions + blurhash, and r.assets.put / apply produce parity refs", async () => {
    // Asserts the v2.3 client surface against the v1.49 gateway encoder.
    // Uploads the same JPEG bytes via two write paths and asserts the
    // returned AssetRefs have all variant fields populated and parity
    // holds across paths.
    //
    // This test is a CONTRACT assertion, not a soft "if present" probe.
    // The v1.49 gateway change ships variant generation on both write
    // paths (parent change Section 4 service-key + Section 5 wallet-apply).
    // If this test fails, the gateway is failing to surface variants
    // through the API even though they're encoded server-side — that's a
    // real product gap that blocks every SDK consumer of variants. Don't
    // weaken the test to match a broken production state.
    const FIXTURES = join(ROOT, "integration-fixtures", "image-variants");
    const jpegBytes = new Uint8Array(readFileSync(join(FIXTURES, "source.jpg")));
    const putKey = `fullstack/image-variants/put-${RUN_ID}.jpg`;
    const applyKey = `fullstack/image-variants/apply-${RUN_ID}.jpg`;
    createdBlobKeys.add(putKey);
    createdBlobKeys.add(applyKey);

    // Path A: single-shot r.assets.put.
    const putRef = await r.assets.put(projectId, putKey, { bytes: jpegBytes }, {
      contentType: "image/jpeg",
    });

    // All v1.49 fields populated on the put path.
    assert.equal(putRef.variant_spec_version, "v1", "variant_spec_version must be v1");
    assert.ok(typeof putRef.width_px === "number" && putRef.width_px === 640, `width_px should be 640, got ${putRef.width_px}`);
    assert.ok(typeof putRef.height_px === "number" && putRef.height_px === 480, `height_px should be 480, got ${putRef.height_px}`);
    assert.ok(typeof putRef.blurhash === "string" && putRef.blurhash.length > 0, "blurhash should be a non-empty string");
    assert.ok(putRef.variants, "variants map must be populated for a ≥320 image");
    assert.ok(putRef.variants.thumb, "variants.thumb must be present");
    assert.ok(putRef.variants.medium, "variants.medium must be present");
    assert.ok(putRef.variants.large, "variants.large must be present");
    assert.equal(putRef.variants.thumb?.format, "webp");
    assert.equal(putRef.variants.medium?.format, "webp");
    assert.equal(putRef.variants.large?.format, "webp");
    assert.equal(putRef.variants.display_jpeg, undefined, "non-HEIC sources must NOT include display_jpeg");
    // Non-HEIC: display_url equals the wire's mutable cdn_url (which the
    // SDK exposes as `cdnMutableUrl` — `cdnUrl` aliases the immutable
    // form). display_immutable_url equals the SDK's `cdnUrl`.
    assert.equal(putRef.display_url, putRef.cdnMutableUrl, "non-HEIC display_url should equal the wire cdn_url (mutable form)");
    assert.equal(putRef.display_immutable_url, putRef.cdnUrl, "non-HEIC display_immutable_url should equal the wire cdn_immutable_url");
    // SDK convenience getters are present for image refs.
    assert.equal(putRef.thumbUrl, putRef.variants.thumb?.cdn_url);
    assert.equal(putRef.displayUrl, putRef.display_url);

    // The source bytes are preserved verbatim and served at cdn_url.
    const putCdnUrl = putRef.cdnUrl ?? putRef.cdn_immutable_url;
    assert.ok(putCdnUrl, "JPEG upload must return a cdn_url");
    await eventually("JPEG source served at cdn_url", async () => {
      const res = await fetch(putCdnUrl, { headers: { "cache-control": "no-cache" } });
      assert.equal(res.status, 200);
      const ctype = res.headers.get("content-type") ?? "";
      assert.ok(ctype.includes("image/jpeg"), `cdn_url should serve image/jpeg, got '${ctype}'`);
    });

    // The variant URL is actually served by the CDN.
    await eventually("thumb cdn fetch", async () => {
      const res = await fetch(putRef.variants!.thumb!.cdn_url, { headers: { "cache-control": "no-cache" } });
      assert.equal(res.status, 200, `thumb cdn_url returned ${res.status}`);
      const ctype = res.headers.get("content-type") ?? "";
      assert.ok(ctype.includes("image/webp"), `thumb Content-Type should be image/webp, got '${ctype}'`);
    });

    // Path B: wallet-apply via r.project(id).apply.
    // resolveContent (the apply-path source resolver) accepts bare
    // Uint8Array, not the { bytes } wrapper that r.assets.put normalizes.
    const project = await r.project(projectId);
    const applyResult = await project.apply({
      assets: {
        put: [{ key: applyKey, source: jpegBytes, content_type: "image/jpeg" }],
      },
    });
    const applyRef = applyResult.assets?.byKey[applyKey];
    assert.ok(applyRef, "apply path must return a populated AssetManifestEntry for the key");

    // Parity: the two refs differ in URL paths (different keys) but agree on
    // every image-variant field that's content-derived.
    assert.equal(applyRef.variant_spec_version, putRef.variant_spec_version);
    assert.equal(applyRef.width_px, putRef.width_px);
    assert.equal(applyRef.height_px, putRef.height_px);
    assert.equal(applyRef.blurhash, putRef.blurhash, "blurhash should match across paths for identical source bytes");
    assert.ok(applyRef.variants, "apply path must also populate variants");
    // Variant SHAs (content of the encoded variants) are deterministic per
    // source SHA + spec version, so cross-path equality verifies the
    // encoder isn't running twice or producing different bytes.
    assert.equal(applyRef.variants!.thumb?.sha256, putRef.variants.thumb?.sha256, "thumb variant sha256 should match across paths");
    assert.equal(applyRef.variants!.medium?.sha256, putRef.variants.medium?.sha256, "medium variant sha256 should match across paths");
    assert.equal(applyRef.variants!.large?.sha256, putRef.variants.large?.sha256, "large variant sha256 should match across paths");
    // Variant dimensions are also deterministic across paths.
    assert.equal(applyRef.variants!.thumb?.width_px, putRef.variants.thumb?.width_px);
    assert.equal(applyRef.variants!.medium?.width_px, putRef.variants.medium?.width_px);
    assert.equal(applyRef.variants!.large?.width_px, putRef.variants.large?.width_px);
  });

  it("(v1.49 image variants) HEIC upload preserves source bytes, surfaces display_jpeg, and parity holds across write paths", async () => {
    // HEIC source: cdn_url serves the original HEIC bytes (audit-friendly),
    // display_url serves a generated JPEG transcode (browser-renderable).
    // variants.display_jpeg is HEIC-only.
    //
    // This test is a CONTRACT assertion. The v1.49 gateway change ships
    // HEIC decode + display_jpeg generation (parent change Section 2).
    // If this test fails, the gateway is failing to deliver on a shipped
    // requirement — that's a real product gap. Don't weaken the test to
    // match a broken production state.
    const FIXTURES = join(ROOT, "integration-fixtures", "image-variants");
    const heicBytes = new Uint8Array(readFileSync(join(FIXTURES, "source.heic")));
    const putKey = `fullstack/image-variants/put-${RUN_ID}.heic`;
    const applyKey = `fullstack/image-variants/apply-${RUN_ID}.heic`;
    createdBlobKeys.add(putKey);
    createdBlobKeys.add(applyKey);

    const putRef = await r.assets.put(projectId, putKey, { bytes: heicBytes }, {
      contentType: "image/heic",
    });

    assert.equal(putRef.variant_spec_version, "v1");
    assert.ok(typeof putRef.width_px === "number" && putRef.width_px > 0, "HEIC ref must have width_px");
    assert.ok(typeof putRef.height_px === "number" && putRef.height_px > 0, "HEIC ref must have height_px");
    assert.ok(typeof putRef.blurhash === "string" && putRef.blurhash.length > 0);
    assert.ok(putRef.variants, "HEIC ref must have variants");
    assert.ok(putRef.variants.display_jpeg, "HEIC source MUST include display_jpeg variant");
    assert.equal(putRef.variants.display_jpeg!.format, "jpeg");
    // display_url must differ from cdn_url for HEIC (cdn_url serves
    // unrenderable HEIC bytes; display_url is the JPEG transcode).
    assert.notEqual(
      putRef.display_url,
      putRef.cdnUrl ?? putRef.cdn_immutable_url,
      "HEIC display_url must NOT equal cdn_url (cdn_url serves unrenderable HEIC)",
    );
    // SDK helpers must use display_url for HEIC.
    assert.equal(putRef.displayUrl, putRef.display_url);

    // Verify the HEIC source bytes are actually served at cdn_url
    // (preserved verbatim per the gateway's "uploaded SHA == stored SHA"
    // invariant).
    await eventually("HEIC source served at cdn_url", async () => {
      const cdnUrl = putRef.cdnUrl ?? putRef.cdn_immutable_url;
      const res = await fetch(cdnUrl!, { headers: { "cache-control": "no-cache" } });
      assert.equal(res.status, 200);
      const ctype = res.headers.get("content-type") ?? "";
      assert.ok(
        ctype.includes("image/heic") || ctype.includes("image/heif"),
        `HEIC cdn_url should serve image/heic, got '${ctype}'`,
      );
    });

    // Verify the JPEG display variant renders.
    await eventually("HEIC display_url serves JPEG", async () => {
      const res = await fetch(putRef.display_url!, { headers: { "cache-control": "no-cache" } });
      assert.equal(res.status, 200);
      const ctype = res.headers.get("content-type") ?? "";
      assert.ok(ctype.includes("image/jpeg"), `HEIC display_url should serve image/jpeg, got '${ctype}'`);
    });

    // Parity: same bytes via wallet-apply path yields identical variant
    // shape including display_jpeg. resolveContent accepts bare
    // Uint8Array, not the { bytes } wrapper.
    const project = await r.project(projectId);
    const applyResult = await project.apply({
      assets: {
        put: [{ key: applyKey, source: heicBytes, content_type: "image/heic" }],
      },
    });
    const applyRef = applyResult.assets?.byKey[applyKey];
    assert.ok(applyRef, "wallet-apply must return a manifest entry for the HEIC upload");
    assert.equal(applyRef.variant_spec_version, "v1");
    assert.ok(applyRef.variants?.display_jpeg, "wallet-apply HEIC ref must include display_jpeg");
    assert.equal(applyRef.variants!.display_jpeg!.sha256, putRef.variants.display_jpeg!.sha256, "HEIC JPEG display variant sha256 must match across paths");
    assert.equal(applyRef.blurhash, putRef.blurhash);
    assert.equal(applyRef.width_px, putRef.width_px);
    assert.equal(applyRef.height_px, putRef.height_px);
  });

  it("observes runtime secrets and exercises email plus AI helper paths", async () => {
    const secret = await directFunctionJson({
      headers: apiHeaders("service"),
      body: { action: "secret" },
    });
    assert.equal(secret.present, true);
    assert.equal(secret.length, TEST_SECRET_VALUE.length);
    assert.equal(JSON.stringify(secret).includes(TEST_SECRET_VALUE), false);

    const emailResult = await directFunctionJson({
      headers: apiHeaders("service"),
      body: { action: "email" },
    });
    if (EMAIL_TO) {
      assert.equal(emailResult.status, "sent");
      assert.ok(emailResult.id);
    } else {
      assert.equal(emailResult.status, "skipped");
      assert.match(String(emailResult.reason), /RUN402_FULLSTACK_EMAIL_TO/);
    }

    const aiResult = await directFunctionJson({
      headers: apiHeaders("service"),
      body: { action: "ai" },
    });
    assert.ok(["ok", "skipped"].includes(String(aiResult.status)));
    if (aiResult.status === "ok") {
      assert.equal(typeof aiResult.flagged, "boolean");
      assert.ok(Array.isArray(aiResult.categoryKeys));
    } else {
      assert.ok(aiResult.reason);
    }

    // Gap 1: ai.translate() — /ai/v1/translate
    const translateResult = await directFunctionJson({
      headers: apiHeaders("service"),
      body: { action: "ai-translate" },
    });
    assert.ok(["ok", "skipped"].includes(String(translateResult.status)));
    if (translateResult.status === "ok") {
      assert.equal(translateResult.to, "es");
      assert.equal(translateResult.has_text, true);
    } else {
      assert.ok(translateResult.reason);
    }

    // Gap 2: ai.generateImage() — /generate-image/v1
    const generateImageResult = await directFunctionJson({
      headers: apiHeaders("service"),
      body: { action: "ai-generate-image" },
    });
    assert.ok(["ok", "skipped"].includes(String(generateImageResult.status)));
    if (generateImageResult.status === "ok") {
      assert.equal(generateImageResult.aspect, "square");
      assert.equal(generateImageResult.has_image, true);
      assert.ok(String(generateImageResult.content_type).startsWith("image/"));
    } else {
      assert.ok(generateImageResult.reason);
    }

    // Gap 4: email.send() with template — /mailboxes/v1/:id/messages with template body
    const emailTemplateResult = await directFunctionJson({
      headers: apiHeaders("service"),
      body: { action: "email-template" },
    });
    if (EMAIL_TO && EMAIL_TEMPLATE) {
      assert.equal(emailTemplateResult.status, "sent");
      assert.ok(emailTemplateResult.id);
    } else {
      assert.equal(emailTemplateResult.status, "skipped");
    }

    // Gap 5: routedHttp helpers — callable in function runtime, produce correct RoutedHttpResponseV1 shape
    const routedHttpResult = await directFunctionJson({
      headers: apiHeaders("service"),
      body: { action: "routedhttp" },
    });
    assert.equal(routedHttpResult.ok, true);
    assert.equal((routedHttpResult.json as any)?.contentType, "application/json; charset=utf-8");
    assert.equal((routedHttpResult.json as any)?.status, 200);
    assert.ok(((routedHttpResult.json as any)?.bodySize ?? 0) > 0);
    assert.equal((routedHttpResult.text as any)?.contentType, "text/plain; charset=utf-8");
    assert.equal((routedHttpResult.text as any)?.status, 200);
    assert.equal((routedHttpResult.bytes as any)?.bodySize, 3);
  });

  it("fetches active and by-id release inventories with full-stack resource metadata", async () => {
    const active = await r._applyEngine.getActiveRelease({ project: projectId, siteLimit: 50 });
    assertInventory("active", active);
    // v1.48 unified-apply: assets.put creates intermediate releases, so the
    // active release may be newer than the initial deploy. Just assert it's
    // a valid release id; the by-id lookup below still pins firstReleaseId.
    assert.ok(active.release_id.startsWith("rel_"));
    assert.ok(Array.isArray(active.warnings ?? []));

    const byId = await r._applyEngine.getRelease({ project: projectId, releaseId: firstReleaseId, siteLimit: 50 });
    assertInventory("by-id", byId);
    assert.equal(byId.release_id, firstReleaseId);

    const functionList = await r.functions.list(projectId);
    const scheduled = (functionList.functions ?? functionList).find((fn: any) => fn.name === "fullstack-scheduled");
    assert.equal(scheduled?.schedule, "0 0 1 1 *");

    const manual = await r.functions.invoke(projectId, "fullstack-scheduled");
    assert.equal(manual.status, 200);
    assert.equal((manual.body as any).scheduled, true);
    assert.equal((manual.body as any).rows?.[0]?.kind, "scheduled-manual");
  });

  it("reapplies the unchanged fixture and asserts idempotent/no-op behavior", async () => {
    const result = await r._applyEngine.apply(initialSpec, {
      idempotencyKey: `fullstack-${RUN_ID}-unchanged`,
    });
    assert.ok(result.release_id.startsWith("rel_"));
    assert.ok(result.operation_id.startsWith("op_"));
    assertNoopLike(result);
  });

  it("applies a small site patch and verifies release diff/static observability", async () => {
    const previousReleaseId = firstReleaseId;
    const changed = await r._applyEngine.apply(buildChangedSpec(), {
      idempotencyKey: `fullstack-${RUN_ID}-changed`,
    });
    changedReleaseId = changed.release_id;
    publicBase = choosePublicBase(changed.urls);
    assert.ok(changedReleaseId.startsWith("rel_"));

    const diff = await r._applyEngine.diff({
      project: projectId,
      from: previousReleaseId,
      to: changedReleaseId,
      limit: 50,
    });
    const changedSitePaths = [
      ...(diff.site?.added ?? []).map((entry: any) => entry.path),
      ...(diff.site?.changed ?? []).map((entry: any) => entry.path),
    ];
    assert.ok(changedSitePaths.includes("version.txt"), `site diff paths: ${changedSitePaths.join(", ")}`);
    assert.ok(
      Number(diff.static_assets?.added ?? 0) + Number(diff.static_assets?.changed ?? 0) >= 1 ||
      changedSitePaths.includes("version.txt"),
    );
    assert.ok((diff.routes?.changed ?? []).length === 0, "site-only patch should preserve routes");
  });

  it("deletes fixture blobs idempotently", async () => {
    for (const key of Array.from(createdBlobKeys)) {
      await removeBlobKey(key);
      await removeBlobKey(key);
      createdBlobKeys.delete(key);
    }
    const listed = await r.assets.ls(projectId, { prefix: "fullstack/" });
    assert.equal((listed.blobs ?? []).some((blob: any) => createdBlobKeys.has(blob.key)), false);
  });
});
