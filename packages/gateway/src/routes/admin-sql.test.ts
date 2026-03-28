import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mock dependencies before importing the module under test
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockClientQueries: Array<{ sql: string; result?: any; error?: Error }>;
let clientQueryLog: string[];
let clientParamsLog: Array<unknown[] | undefined>;
let clientReleased: boolean;

// Pool-level query mock (used by pin/unpin/schema handlers that call pool.query directly)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolQueries: Array<{ sql: string; result?: any; error?: Error }> = [];
let poolQueryLog: string[] = [];

const fakeClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query(sql: string, params?: unknown[]): Promise<any> {
    clientQueryLog.push(sql);
    clientParamsLog.push(params);
    for (const entry of mockClientQueries) {
      if (sql === entry.sql || sql.includes(entry.sql)) {
        if (entry.error) throw entry.error;
        return entry.result;
      }
    }
    // Default: BEGIN, SET search_path, NOTIFY, COMMIT, ROLLBACK succeed silently
    return { rows: [], rowCount: 0 };
  },
  release() {
    clientReleased = true;
  },
};

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      connect: async () => fakeClient,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async query(sql: string, _params?: unknown[]): Promise<any> {
        poolQueryLog.push(sql);
        for (const entry of mockPoolQueries) {
          if (sql === entry.sql || sql.includes(entry.sql)) {
            if (entry.error) throw entry.error;
            return entry.result;
          }
        }
        return { rows: [], rowCount: 0 };
      },
    },
  },
});

// Mock serviceKeyAuth — pass-through (tests set req.project directly)
mock.module("../middleware/apikey.js", {
  namedExports: {
    serviceKeyAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  },
});

// Mock config — must provide all exports transitively imported by admin.ts
mock.module("../config.js", {
  namedExports: {
    ADMIN_KEY: "test-admin-key",
    MAX_SCHEMA_SLOTS: 2000,
    JWT_SECRET: "test-jwt-secret",
    POSTGREST_URL: "http://localhost:3000",
    S3_BUCKET: "",
    S3_REGION: "us-east-1",
    LAMBDA_ROLE_ARN: "",
    LAMBDA_LAYER_ARN: "",
    LAMBDA_SUBNET_IDS: "",
    LAMBDA_SG_ID: "",
    FUNCTIONS_LOG_GROUP: "/test/functions",
    BUGSNAG_API_KEY: "",
    SELLER_ADDRESS: "",
    CDP_API_KEY_ID: "",
    CDP_API_KEY_SECRET: "",
    STRIPE_SECRET_KEY: "",
    STRIPE_PUBLISHABLE_KEY: "",
    FACILITATOR_PROVIDER: "cdp",
    FACILITATOR_URL: "",
    TESTNET_FACILITATOR_URL: "",
    MAINNET_NETWORK: "eip155:8453",
    TESTNET_NETWORK: "eip155:84532",
    PORT: 4022,
    RATE_LIMIT_PER_SEC: 100,
    METERING_FLUSH_INTERVAL: 60000,
    FAUCET_TREASURY_KEY: "",
    FAUCET_DRIP_AMOUNT: "0.25",
    FAUCET_DRIP_COOLDOWN: 86400000,
    FAUCET_REFILL_INTERVAL: 8640000,
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    OPENROUTER_API_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    STRIPE_WEBHOOK_SECRET_LIVE: "",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    ADMIN_SESSION_SECRET: "",
    MPP_SECRET_KEY: "",
    GOOGLE_APP_CLIENT_ID: "",
    GOOGLE_APP_CLIENT_SECRET: "",
    PUBLIC_API_URL: "http://localhost:4022",
  },
});

// Import after mocks
const { default: router } = await import("./admin.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findHandler(method: string, path: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (router as any).stack) {
    if (
      layer.route &&
      layer.route.path === path &&
      layer.route.methods[method.toLowerCase()]
    ) {
      // Return the last handler (the asyncHandler-wrapped one, after middleware)
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`No handler found for ${method} ${path}`);
}

const sqlHandler = findHandler("post", "/projects/v1/admin/:id/sql");
const rlsHandler = findHandler("post", "/projects/v1/admin/:id/rls");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeReq(overrides: Record<string, any> = {}) {
  return {
    method: "POST",
    params: { id: "proj-1" },
    project: { id: "proj-1", schemaSlot: "p0001" },
    headers: {} as Record<string, string>,
    get(name: string) {
      return (this.headers as Record<string, string>)[name.toLowerCase()];
    },
    body: undefined as string | undefined,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeRes(onDone: () => void) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: Record<string, any> = {
    _status: 200,
    _body: null,
    status(code: number) { res._status = code; return res; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json(obj: any) { res._body = obj; onDone(); return res; },
  };
  return res;
}

// asyncHandler doesn't return the inner promise, so we resolve via res.json or next(err)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callHandler(req: any): Promise<{ res: Record<string, any>; err?: Error }> {
  return new Promise((resolve) => {
    const res = fakeRes(() => resolve({ res }));
    sqlHandler(req, res, (err?: Error) => resolve({ res, err }));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /projects/v1/admin/:id/sql", () => {
  beforeEach(() => {
    mockClientQueries = [];
    clientQueryLog = [];
    clientParamsLog = [];
    clientReleased = false;
  });

  // --- Single-statement SQL ---

  it("executes single-statement SQL and returns rows + rowCount", async () => {
    mockClientQueries = [
      { sql: "INSERT INTO users", result: { rows: [{ id: 1 }], rowCount: 1 } },
    ];

    const req = fakeReq({
      body: "INSERT INTO users (name) VALUES ('alice')",
      headers: { "content-type": "text/plain" },
    });
    const { res, err } = await callHandler(req);

    assert.equal(err, undefined, "no error");
    assert.equal(res._body.status, "ok");
    assert.equal(res._body.schema, "p0001");
    assert.deepEqual(res._body.rows, [{ id: 1 }]);
    assert.equal(res._body.rowCount, 1);
  });

  // --- Multi-statement SQL (the bug) ---

  it("handles multi-statement SQL returning array of results", async () => {
    // pg returns an array of Result objects for multi-statement queries
    const multiResult = [
      { rows: [{ id: 1 }], rowCount: 1 },
      { rows: [{ id: 2 }], rowCount: 1 },
      { rows: [{ id: 3 }], rowCount: 1 },
    ];
    mockClientQueries = [
      { sql: "INSERT INTO users", result: multiResult },
    ];

    const req = fakeReq({
      body: "INSERT INTO users VALUES (1); INSERT INTO users VALUES (2); INSERT INTO users VALUES (3)",
      headers: { "content-type": "text/plain" },
    });
    const { res, err } = await callHandler(req);

    assert.equal(err, undefined, "no error");
    assert.equal(res._body.status, "ok");
    // rows come from the last statement
    assert.deepEqual(res._body.rows, [{ id: 3 }]);
    // rowCount is the sum across all statements
    assert.equal(res._body.rowCount, 3);
  });

  it("handles multi-statement SQL with empty rows", async () => {
    const multiResult = [
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ];
    mockClientQueries = [
      { sql: "INSERT INTO", result: multiResult },
    ];

    const req = fakeReq({
      body: "INSERT INTO a VALUES (1); INSERT INTO b VALUES (2)",
      headers: { "content-type": "text/plain" },
    });
    const { res, err } = await callHandler(req);

    assert.equal(err, undefined);
    assert.deepEqual(res._body.rows, []);
    assert.equal(res._body.rowCount, 2);
  });

  // --- SQL error returns 400 with message (not silent 500) ---

  it("returns 400 with pg error message instead of silent 500", async () => {
    mockClientQueries = [
      { sql: "INSERT INTO nonexistent", error: new Error('relation "nonexistent" does not exist') },
    ];

    const req = fakeReq({
      body: "INSERT INTO nonexistent VALUES (1)",
      headers: { "content-type": "text/plain" },
    });
    const { err } = await callHandler(req);

    assert.ok(err, "error forwarded to Express");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((err as any).statusCode, 400);
    assert.ok(err!.message.includes("nonexistent"), `error message includes table name: ${err!.message}`);
    assert.ok(err!.message.includes("SQL error:"), "prefixed with SQL error:");
  });

  it("returns 400 with syntax error details", async () => {
    mockClientQueries = [
      { sql: "SELEC", error: new Error('syntax error at or near "SELEC"') },
    ];

    const req = fakeReq({
      body: "SELEC * FROM users",
      headers: { "content-type": "text/plain" },
    });
    const { err } = await callHandler(req);

    assert.ok(err);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((err as any).statusCode, 400);
    assert.ok(err!.message.includes("SELEC"));
  });

  // --- ROLLBACK on error ---

  it("issues ROLLBACK when SQL fails", async () => {
    mockClientQueries = [
      { sql: "INSERT INTO bad", error: new Error("constraint violation") },
    ];

    const req = fakeReq({
      body: "INSERT INTO bad VALUES (1)",
      headers: { "content-type": "text/plain" },
    });
    await callHandler(req);

    assert.ok(clientQueryLog.includes("ROLLBACK"), "ROLLBACK was issued");
    assert.ok(!clientQueryLog.includes("COMMIT"), "COMMIT was NOT issued");
  });

  it("releases client even when SQL fails", async () => {
    mockClientQueries = [
      { sql: "INSERT INTO bad", error: new Error("fail") },
    ];

    const req = fakeReq({
      body: "INSERT INTO bad VALUES (1)",
      headers: { "content-type": "text/plain" },
    });
    await callHandler(req);

    assert.ok(clientReleased, "client was released in finally block");
  });

  // --- Transaction structure ---

  it("wraps SQL in BEGIN/SET search_path/NOTIFY/COMMIT", async () => {
    mockClientQueries = [
      { sql: "CREATE TABLE", result: { rows: [], rowCount: 0 } },
    ];

    const req = fakeReq({
      body: "CREATE TABLE t (id int)",
      headers: { "content-type": "text/plain" },
    });
    await callHandler(req);

    assert.equal(clientQueryLog[0], "BEGIN");
    assert.equal(clientQueryLog[1], "SET search_path TO p0001");
    assert.ok(clientQueryLog[2].includes("CREATE TABLE"));
    assert.equal(clientQueryLog[3], "NOTIFY pgrst, 'reload schema'");
    assert.equal(clientQueryLog[4], "COMMIT");
  });

  // --- JSON body parsing ---

  it("accepts JSON body with sql field", async () => {
    mockClientQueries = [
      { sql: "SELECT 1", result: { rows: [{ "?column?": 1 }], rowCount: 1 } },
    ];

    const req = fakeReq({
      body: JSON.stringify({ sql: "SELECT 1" }),
      headers: { "content-type": "application/json" },
    });
    const { res, err } = await callHandler(req);

    assert.equal(err, undefined);
    assert.equal(res._body.status, "ok");
  });

  it("accepts JSON body with query field", async () => {
    mockClientQueries = [
      { sql: "SELECT 1", result: { rows: [{ "?column?": 1 }], rowCount: 1 } },
    ];

    const req = fakeReq({
      body: JSON.stringify({ query: "SELECT 1" }),
      headers: { "content-type": "application/json" },
    });
    const { res, err } = await callHandler(req);

    assert.equal(err, undefined);
    assert.equal(res._body.status, "ok");
  });

  // --- Parameterized queries ---

  it("accepts JSON body with sql and params fields", async () => {
    mockClientQueries = [
      { sql: "SELECT $1::text AS val", result: { rows: [{ val: "hello" }], rowCount: 1 } },
    ];

    const req = fakeReq({
      body: JSON.stringify({ sql: "SELECT $1::text AS val", params: ["hello"] }),
      headers: { "content-type": "application/json" },
    });
    const { res, err } = await callHandler(req);

    assert.equal(err, undefined);
    assert.equal(res._body.status, "ok");
    assert.deepEqual(res._body.rows, [{ val: "hello" }]);
    // The user SQL query is the 3rd call (after BEGIN, SET search_path)
    const userQueryIndex = clientQueryLog.indexOf("SELECT $1::text AS val");
    assert.ok(userQueryIndex >= 0, "user query was logged");
    assert.deepEqual(clientParamsLog[userQueryIndex], ["hello"]);
  });

  it("does not pass params for text/plain body", async () => {
    mockClientQueries = [
      { sql: "SELECT 1", result: { rows: [{ "?column?": 1 }], rowCount: 1 } },
    ];

    const req = fakeReq({
      body: "SELECT 1",
      headers: { "content-type": "text/plain" },
    });
    const { res, err } = await callHandler(req);

    assert.equal(err, undefined);
    assert.equal(res._body.status, "ok");
    // All query calls should have undefined params
    for (const p of clientParamsLog) {
      assert.equal(p, undefined);
    }
  });

  it("treats empty params array same as no params", async () => {
    mockClientQueries = [
      { sql: "SELECT 1", result: { rows: [{ "?column?": 1 }], rowCount: 1 } },
    ];

    const req = fakeReq({
      body: JSON.stringify({ sql: "SELECT 1", params: [] }),
      headers: { "content-type": "application/json" },
    });
    const { res, err } = await callHandler(req);

    assert.equal(err, undefined);
    assert.equal(res._body.status, "ok");
    // Empty params should not be passed through
    for (const p of clientParamsLog) {
      assert.equal(p, undefined);
    }
  });

  it("rejects non-array params with 400", async () => {
    const req = fakeReq({
      body: JSON.stringify({ sql: "SELECT 1", params: "not-an-array" }),
      headers: { "content-type": "application/json" },
    });
    const { err } = await callHandler(req);

    assert.ok(err);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((err as any).statusCode, 400);
    assert.ok(err!.message.includes('"params" must be an array'));
  });

  // --- Input validation ---

  it("returns 400 when no SQL provided", async () => {
    const req = fakeReq({
      body: "",
      headers: { "content-type": "text/plain" },
    });
    const { err } = await callHandler(req);

    assert.ok(err);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((err as any).statusCode, 400);
    assert.ok(err!.message.includes("No SQL provided"));
  });

  it("returns 403 for blocked SQL patterns", async () => {
    const req = fakeReq({
      body: "CREATE EXTENSION pgcrypto",
      headers: { "content-type": "text/plain" },
    });
    const { err } = await callHandler(req);

    assert.ok(err);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((err as any).statusCode, 403);
    assert.ok(err!.message.includes("Blocked SQL pattern"));
  });
});

// ---------------------------------------------------------------------------
// RLS endpoint tests
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callRlsHandler(req: any): Promise<{ res: Record<string, any>; err?: Error }> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: Record<string, any> = {
      _status: 200,
      _body: null,
      status(code: number) { res._status = code; return res; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      json(obj: any) { res._body = obj; resolve({ res }); return res; },
    };
    rlsHandler(req, res, (err?: Error) => resolve({ res, err }));
  });
}

describe("POST /projects/v1/admin/:id/rls — user_owns_rows", () => {
  beforeEach(() => {
    mockClientQueries = [];
    clientQueryLog = [];
    clientParamsLog = [];
    clientReleased = false;
  });

  it("casts auth.uid() to TEXT so owner_column can be text or uuid", async () => {
    const req = fakeReq({
      body: {
        template: "user_owns_rows",
        tables: [{ table: "tasks", owner_column: "user_id" }],
      },
    });
    const { err } = await callRlsHandler(req);
    assert.equal(err, undefined, "no error");

    // Every policy must cast both sides to ::text for type-safe comparison
    // (owner_column can be TEXT or UUID, auth.uid() returns UUID)
    const policySql = clientQueryLog.filter((q) => q.includes("auth.uid()"));
    assert.equal(policySql.length, 4, "should have 4 policies referencing auth.uid()");
    for (const sql of policySql) {
      assert.ok(
        sql.includes("user_id::text = auth.uid()::text"),
        `policy should cast both sides to text, got: ${sql.trim()}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Pin endpoint tests
// ---------------------------------------------------------------------------

const pinHandler = findHandler("post", "/projects/v1/admin/:id/pin");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callPinHandler(req: any): Promise<{ res: Record<string, any>; err?: Error }> {
  return new Promise((resolve) => {
    const res = fakeRes(() => resolve({ res }));
    pinHandler(req, res, (err?: Error) => resolve({ res, err }));
  });
}

describe("POST /projects/v1/admin/:id/pin", () => {
  beforeEach(() => {
    mockPoolQueries = [];
    poolQueryLog = [];
  });

  it("pins a project and returns { status, project_id, pinned: true }", async () => {
    mockPoolQueries = [
      { sql: "UPDATE internal.projects SET pinned = true", result: { rows: [], rowCount: 1 } },
    ];

    const req = fakeReq({
      headers: { "x-admin-key": "test-admin-key" },
      project: { id: "proj-1", schemaSlot: "p0001", pinned: false },
    });
    const { res, err } = await callPinHandler(req);

    assert.equal(err, undefined, "no error");
    assert.equal(res._body.status, "ok");
    assert.equal(res._body.project_id, "proj-1");
    assert.equal(res._body.pinned, true);
  });

  it("calls pool.query with UPDATE ... SET pinned = true", async () => {
    mockPoolQueries = [
      { sql: "UPDATE internal.projects SET pinned = true", result: { rows: [], rowCount: 1 } },
    ];

    const req = fakeReq({
      headers: { "x-admin-key": "test-admin-key" },
      project: { id: "proj-1", schemaSlot: "p0001", pinned: false },
    });
    await callPinHandler(req);

    assert.ok(
      poolQueryLog.some((q) => q.includes("UPDATE internal.projects SET pinned = true")),
      "should execute UPDATE with pinned = true",
    );
  });

  it("rejects without admin key", async () => {
    const req = fakeReq({
      headers: {},
      project: { id: "proj-1", schemaSlot: "p0001", pinned: false },
    });
    const { err } = await callPinHandler(req);

    assert.ok(err, "error forwarded");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((err as any).statusCode, 403);
  });
});

// ---------------------------------------------------------------------------
// Unpin endpoint tests
// ---------------------------------------------------------------------------

const unpinHandler = findHandler("post", "/projects/v1/admin/:id/unpin");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callUnpinHandler(req: any): Promise<{ res: Record<string, any>; err?: Error }> {
  return new Promise((resolve) => {
    const res = fakeRes(() => resolve({ res }));
    unpinHandler(req, res, (err?: Error) => resolve({ res, err }));
  });
}

describe("POST /projects/v1/admin/:id/unpin", () => {
  beforeEach(() => {
    mockPoolQueries = [];
    poolQueryLog = [];
  });

  it("unpins a project and returns { status, project_id, pinned: false }", async () => {
    mockPoolQueries = [
      { sql: "UPDATE internal.projects SET pinned = false", result: { rows: [], rowCount: 1 } },
    ];

    const req = fakeReq({
      headers: { "x-admin-key": "test-admin-key" },
      project: { id: "proj-1", schemaSlot: "p0001", pinned: true },
    });
    const { res, err } = await callUnpinHandler(req);

    assert.equal(err, undefined, "no error");
    assert.equal(res._body.status, "ok");
    assert.equal(res._body.project_id, "proj-1");
    assert.equal(res._body.pinned, false);
  });

  it("calls pool.query with UPDATE ... SET pinned = false", async () => {
    mockPoolQueries = [
      { sql: "UPDATE internal.projects SET pinned = false", result: { rows: [], rowCount: 1 } },
    ];

    const req = fakeReq({
      headers: { "x-admin-key": "test-admin-key" },
      project: { id: "proj-1", schemaSlot: "p0001", pinned: true },
    });
    await callUnpinHandler(req);

    assert.ok(
      poolQueryLog.some((q) => q.includes("UPDATE internal.projects SET pinned = false")),
      "should execute UPDATE with pinned = false",
    );
  });

  it("rejects without admin key", async () => {
    const req = fakeReq({
      headers: {},
      project: { id: "proj-1", schemaSlot: "p0001", pinned: true },
    });
    const { err } = await callUnpinHandler(req);

    assert.ok(err, "error forwarded");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((err as any).statusCode, 403);
  });
});

// ---------------------------------------------------------------------------
// Usage endpoint tests
// ---------------------------------------------------------------------------

const usageHandler = findHandler("get", "/projects/v1/admin/:id/usage");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callUsageHandler(req: any): Promise<{ res: Record<string, any>; err?: Error }> {
  return new Promise((resolve) => {
    const res = fakeRes(() => resolve({ res }));
    usageHandler(req, res, (err?: Error) => resolve({ res, err }));
  });
}

describe("GET /projects/v1/admin/:id/usage", () => {
  it("returns usage stats and tier limits for prototype tier", async () => {
    const req = fakeReq({
      method: "GET",
      project: {
        id: "proj-1",
        schemaSlot: "p0001",
        tier: "prototype",
        apiCalls: 1234,
        storageBytes: 5678,
        status: "active",
      },
    });
    const { res, err } = await callUsageHandler(req);

    assert.equal(err, undefined, "no error");
    assert.equal(res._body.project_id, "proj-1");
    assert.equal(res._body.tier, "prototype");
    assert.equal(res._body.api_calls, 1234);
    assert.equal(res._body.storage_bytes, 5678);
    assert.equal(res._body.status, "active");
    // prototype tier: 500_000 api calls, 250 MB storage
    assert.equal(res._body.api_calls_limit, 500_000);
    assert.equal(res._body.storage_limit_bytes, 250 * 1024 * 1024);
  });

  it("returns usage stats for hobby tier", async () => {
    const req = fakeReq({
      method: "GET",
      project: {
        id: "proj-1",
        schemaSlot: "p0001",
        tier: "hobby",
        apiCalls: 100_000,
        storageBytes: 1_000_000,
        status: "active",
      },
    });
    const { res, err } = await callUsageHandler(req);

    assert.equal(err, undefined, "no error");
    assert.equal(res._body.tier, "hobby");
    // hobby tier: 5_000_000 api calls, 1024 MB storage
    assert.equal(res._body.api_calls_limit, 5_000_000);
    assert.equal(res._body.storage_limit_bytes, 1024 * 1024 * 1024);
  });

  it("rejects when req.project is missing", async () => {
    const req = fakeReq({
      method: "GET",
      project: undefined,
    });
    // Usage handler is synchronous so errors are thrown directly
    assert.throws(
      () => usageHandler(req, fakeRes(() => {}), () => {}),
      (thrown: Error) => thrown.message.includes("Project authentication required"),
    );
  });
});

// ---------------------------------------------------------------------------
// Schema endpoint tests
// ---------------------------------------------------------------------------

const schemaHandler = findHandler("get", "/projects/v1/admin/:id/schema");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callSchemaHandler(req: any): Promise<{ res: Record<string, any>; err?: Error }> {
  return new Promise((resolve) => {
    const res = fakeRes(() => resolve({ res }));
    schemaHandler(req, res, (err?: Error) => resolve({ res, err }));
  });
}

describe("GET /projects/v1/admin/:id/schema", () => {
  beforeEach(() => {
    mockPoolQueries = [];
    poolQueryLog = [];
  });

  it("returns schema introspection with tables, columns, constraints, and policies", async () => {
    mockPoolQueries = [
      // tables query
      {
        sql: "information_schema.tables",
        result: { rows: [{ table_name: "users" }] },
      },
      // columns query
      {
        sql: "information_schema.columns",
        result: {
          rows: [
            { column_name: "id", data_type: "uuid", is_nullable: "NO", column_default: "gen_random_uuid()" },
            { column_name: "name", data_type: "text", is_nullable: "YES", column_default: null },
          ],
        },
      },
      // constraints query
      {
        sql: "table_constraints",
        result: {
          rows: [
            { constraint_name: "users_pkey", constraint_type: "PRIMARY KEY", definition: "PRIMARY KEY (id)" },
          ],
        },
      },
      // RLS check query
      {
        sql: "relrowsecurity",
        result: { rows: [{ relrowsecurity: true }] },
      },
      // policies query
      {
        sql: "pg_policy",
        result: {
          rows: [
            {
              name: "users_select",
              command: "r",
              using_expression: "(id = auth.uid())",
              check_expression: null,
            },
          ],
        },
      },
    ];

    const req = fakeReq({
      method: "GET",
      project: { id: "proj-1", schemaSlot: "p0001" },
    });
    const { res, err } = await callSchemaHandler(req);

    assert.equal(err, undefined, "no error");
    assert.equal(res._body.schema, "p0001");
    assert.equal(res._body.tables.length, 1);

    const table = res._body.tables[0];
    assert.equal(table.name, "users");

    // Columns
    assert.equal(table.columns.length, 2);
    assert.equal(table.columns[0].name, "id");
    assert.equal(table.columns[0].type, "uuid");
    assert.equal(table.columns[0].nullable, false);
    assert.equal(table.columns[0].default_value, "gen_random_uuid()");
    assert.equal(table.columns[1].name, "name");
    assert.equal(table.columns[1].type, "text");
    assert.equal(table.columns[1].nullable, true);
    assert.equal(table.columns[1].default_value, null);

    // Constraints
    assert.equal(table.constraints.length, 1);
    assert.equal(table.constraints[0].name, "users_pkey");
    assert.equal(table.constraints[0].type, "PRIMARY KEY");
    assert.equal(table.constraints[0].definition, "PRIMARY KEY (id)");

    // RLS
    assert.equal(table.rls_enabled, true);

    // Policies
    assert.equal(table.policies.length, 1);
    assert.equal(table.policies[0].name, "users_select");
    assert.equal(table.policies[0].command, "r");
    assert.equal(table.policies[0].using_expression, "(id = auth.uid())");
    assert.equal(table.policies[0].check_expression, null);
  });

  it("returns empty tables array when no tables exist", async () => {
    mockPoolQueries = [
      {
        sql: "information_schema.tables",
        result: { rows: [] },
      },
    ];

    const req = fakeReq({
      method: "GET",
      project: { id: "proj-1", schemaSlot: "p0001" },
    });
    const { res, err } = await callSchemaHandler(req);

    assert.equal(err, undefined, "no error");
    assert.equal(res._body.schema, "p0001");
    assert.deepEqual(res._body.tables, []);
  });

  it("handles tables with RLS disabled and no policies", async () => {
    mockPoolQueries = [
      {
        sql: "information_schema.tables",
        result: { rows: [{ table_name: "logs" }] },
      },
      {
        sql: "information_schema.columns",
        result: {
          rows: [
            { column_name: "id", data_type: "integer", is_nullable: "NO", column_default: null },
          ],
        },
      },
      {
        sql: "table_constraints",
        result: { rows: [] },
      },
      {
        sql: "relrowsecurity",
        result: { rows: [{ relrowsecurity: false }] },
      },
      {
        sql: "pg_policy",
        result: { rows: [] },
      },
    ];

    const req = fakeReq({
      method: "GET",
      project: { id: "proj-1", schemaSlot: "p0001" },
    });
    const { res, err } = await callSchemaHandler(req);

    assert.equal(err, undefined, "no error");
    const table = res._body.tables[0];
    assert.equal(table.name, "logs");
    assert.equal(table.rls_enabled, false);
    assert.deepEqual(table.policies, []);
    assert.deepEqual(table.constraints, []);
  });
});
