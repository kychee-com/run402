import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mock dependencies before importing the module under test
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockGetProjectById: (id: string) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockDeriveProjectKeys: (projectId: string, tier: string) => any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockDeployFunction: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockSetSecret: (...args: any[]) => Promise<void>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockCreateDeployment: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockCreateOrUpdateSubdomain: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolConnect: () => Promise<any>;

mock.module("./projects.js", {
  namedExports: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getProjectById: (id: any) => mockGetProjectById(id),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deriveProjectKeys: (projectId: any, tier: any) => mockDeriveProjectKeys(projectId, tier),
  },
});

mock.module("./functions.js", {
  namedExports: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deployFunction: (...args: any[]) => mockDeployFunction(...args),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setSecret: (...args: any[]) => mockSetSecret(...args),
  },
});

mock.module("./deployments.js", {
  namedExports: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createDeployment: (...args: any[]) => mockCreateDeployment(...args),
  },
});

mock.module("./scheduler.js", {
  namedExports: {
    isValidCron: (expr: string) => {
      try { return /^[\d*/,-]+(\s+[\d*/,-]+){4}$/.test(expr.trim()); } catch { return false; }
    },
    getCronIntervalMinutes: () => 15,
    registerSchedule: () => {},
    cancelSchedule: () => {},
  },
});

mock.module("./subdomains.js", {
  namedExports: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createOrUpdateSubdomain: (...args: any[]) => mockCreateOrUpdateSubdomain(...args),
    validateSubdomainName: (name: string): string | null => {
      const reserved = new Set(["api", "www", "mail", "ftp", "admin"]);
      if (reserved.has(name)) return `"${name}" is reserved`;
      if (name.length < 3) return "Subdomain must be at least 3 characters";
      return null;
    },
  },
});

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      connect: () => mockPoolConnect(),
      query: async () => ({ rows: [{ cnt: 0 }], rowCount: 1 }),
    },
  },
});

// sql() is an identity function — pass through
mock.module("../db/sql.js", {
  namedExports: {
    sql: (q: string) => q,
  },
});

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { validateBundle, deployBundle, BundleError } = await import("./bundle.js");
type BundleRequest = import("./bundle.js").BundleRequest;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "prj_123_1",
    name: "test-project",
    schemaSlot: "p0001",
    tier: "prototype" as const,
    status: "active" as const,
    anonKey: "",
    serviceKey: "",
    apiCalls: 0,
    storageBytes: 0,
    walletAddress: "0xABCD1234",
    pinned: false,
    createdAt: new Date(),
    demoMode: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateBundle tests (existing — preserved exactly)
// ---------------------------------------------------------------------------

describe("bundle validation — project_id", () => {
  it("rejects missing project_id", () => {
    assert.throws(
      () => validateBundle({} as BundleRequest),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400 && err.message.includes("project_id"),
    );
  });

  it("rejects non-string project_id", () => {
    assert.throws(
      () => validateBundle({ project_id: 123 } as unknown as BundleRequest),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400,
    );
  });

  it("rejects invalid project_id format", () => {
    assert.throws(
      () => validateBundle({ project_id: "bad_format" }),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400 && err.message.includes("format"),
    );
  });

  it("rejects project_id without prj_ prefix", () => {
    assert.throws(
      () => validateBundle({ project_id: "123_456" }),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400,
    );
  });

  it("accepts valid project_id", () => {
    assert.doesNotThrow(() => validateBundle({ project_id: "prj_123_1" }));
  });
});

describe("bundle validation — migrations", () => {
  it("rejects non-string migrations", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", migrations: 42 as unknown as string }),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400,
    );
  });

  it("rejects oversized migrations", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", migrations: "x".repeat(1_000_001) }),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400 && err.message.includes("1MB"),
    );
  });

  it("rejects blocked SQL patterns", () => {
    const blocked = [
      "CREATE EXTENSION pgcrypto",
      "ALTER SYSTEM SET work_mem",
      "SET search_path TO public",
      "CREATE SCHEMA evil",
      "DROP SCHEMA p0001",
      "GRANT ALL ON TABLE foo TO evil",
      "REVOKE SELECT ON TABLE foo FROM anon",
      "CREATE ROLE hacker",
    ];
    for (const sql of blocked) {
      assert.throws(
        () => validateBundle({ project_id: "prj_123_1", migrations: sql }),
        (err: InstanceType<typeof BundleError>) => err.statusCode === 403,
        `Should block: ${sql}`,
      );
    }
  });

  it("accepts valid SQL", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        project_id: "prj_123_1",
        migrations: "CREATE TABLE users (id uuid PRIMARY KEY, email text);",
      }),
    );
  });
});

describe("bundle validation — rls", () => {
  it("rejects missing template", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", rls: { template: "", tables: [] } }),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400,
    );
  });

  it("rejects invalid template", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", rls: { template: "evil", tables: [] } }),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400 && err.message.includes("Invalid RLS"),
    );
  });

  it("rejects user_owns_rows without owner_column", () => {
    assert.throws(
      () =>
        validateBundle({
          project_id: "prj_123_1",
          rls: { template: "user_owns_rows", tables: [{ table: "posts" }] },
        }),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400 && err.message.includes("owner_column"),
    );
  });

  it("accepts valid RLS config", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        project_id: "prj_123_1",
        rls: {
          template: "user_owns_rows",
          tables: [{ table: "posts", owner_column: "user_id" }],
        },
      }),
    );
  });
});

describe("bundle validation — secrets", () => {
  it("rejects non-array secrets", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", secrets: "bad" as unknown as [] }),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400,
    );
  });

  it("rejects invalid secret key format", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", secrets: [{ key: "lowercase", value: "x" }] }),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400 && err.message.includes("uppercase"),
    );
  });

  it("rejects missing secret value", () => {
    assert.throws(
      () =>
        validateBundle({
          project_id: "prj_123_1",
          secrets: [{ key: "MY_KEY", value: undefined as unknown as string }],
        }),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400 && err.message.includes("value"),
    );
  });

  it("accepts valid secrets", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        project_id: "prj_123_1",
        secrets: [{ key: "STRIPE_KEY", value: "sk_test_123" }],
      }),
    );
  });
});

describe("bundle validation — functions", () => {
  it("rejects non-array functions", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", functions: "bad" as unknown as [] }),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400,
    );
  });

  it("rejects invalid function name", () => {
    const invalid = ["Hello", "-start", "my_func", ""];
    for (const name of invalid) {
      assert.throws(
        () => validateBundle({ project_id: "prj_123_1", functions: [{ name, code: "x" }] }),
        (err: InstanceType<typeof BundleError>) => err.statusCode === 400,
        `Should reject function name: '${name}'`,
      );
    }
  });

  it("rejects missing code", () => {
    assert.throws(
      () =>
        validateBundle({
          project_id: "prj_123_1",
          functions: [{ name: "hello", code: "" }],
        }),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400 && err.message.includes("code"),
    );
  });

  it("accepts valid functions", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        project_id: "prj_123_1",
        functions: [{ name: "checkout", code: 'export default async (req) => new Response("ok")' }],
      }),
    );
  });
});

describe("bundle validation — files", () => {
  it("rejects empty files array", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", files: [] }),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400 && err.message.includes("non-empty"),
    );
  });

  it("rejects missing file path", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", files: [{ file: "", data: "hi" }] }),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400,
    );
  });

  it("rejects invalid encoding", () => {
    assert.throws(
      () =>
        validateBundle({
          project_id: "prj_123_1",
          files: [{ file: "index.html", data: "hi", encoding: "gzip" as "utf-8" }],
        }),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400 && err.message.includes("encoding"),
    );
  });

  it("accepts valid site files", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        project_id: "prj_123_1",
        files: [
          { file: "index.html", data: "<h1>hello</h1>" },
          { file: "style.css", data: "body { color: red; }" },
        ],
      }),
    );
  });
});

describe("bundle validation — subdomain", () => {
  it("rejects reserved subdomain", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", subdomain: "api" }),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400 && err.message.includes("reserved"),
    );
  });

  it("rejects too-short subdomain", () => {
    assert.throws(
      () => validateBundle({ project_id: "prj_123_1", subdomain: "ab" }),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400,
    );
  });

  it("accepts valid subdomain", () => {
    assert.doesNotThrow(() => validateBundle({ project_id: "prj_123_1", subdomain: "my-cool-app" }));
  });
});

describe("bundle validation — full bundle", () => {
  it("accepts a complete bundle with all fields", () => {
    assert.doesNotThrow(() =>
      validateBundle({
        project_id: "prj_1741340000_42",
        migrations:
          "CREATE TABLE concepts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);",
        rls: {
          template: "public_read",
          tables: [{ table: "concepts" }],
        },
        secrets: [{ key: "OPENAI_API_KEY", value: "sk-test" }],
        functions: [
          {
            name: "embed",
            code: 'export default async (req) => new Response("ok")',
          },
        ],
        files: [{ file: "index.html", data: "<h1>Cosmic Forge</h1>" }],
        subdomain: "cosmic",
      }),
    );
  });

  it("accepts minimal bundle (project_id only)", () => {
    assert.doesNotThrow(() => validateBundle({ project_id: "prj_123_1" }));
  });
});

// ---------------------------------------------------------------------------
// deployBundle tests (new)
// ---------------------------------------------------------------------------

describe("deployBundle — project lookup errors", () => {
  beforeEach(() => {
    mockGetProjectById = async () => null;
    mockDeriveProjectKeys = () => ({ anonKey: "anon-key", serviceKey: "service-key" });
    mockDeployFunction = async () => ({ name: "test", url: "https://example.com/test" });
    mockSetSecret = async () => {};
    mockCreateDeployment = async () => ({ deployment_id: "dep_001", url: "https://sites.run402.com/dep_001" });
    mockCreateOrUpdateSubdomain = async () => ({ name: "test", deployment_id: "dep_001", project_id: "prj_123_1", created_at: "", updated_at: "" });
    mockPoolConnect = async () => {
      const queries: string[] = [];
      return {
        query: async (q: string) => { queries.push(q); return { rows: [] }; },
        release: () => {},
      };
    };
  });

  it("throws 404 when project is not found", async () => {
    mockGetProjectById = async () => null;

    await assert.rejects(
      () => deployBundle({ project_id: "prj_999_1" }, "https://api.run402.com"),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 404 && err.message.includes("not found"),
    );
  });

  it("throws 400 when project is not active", async () => {
    mockGetProjectById = async () => makeProject({ status: "archived" });

    await assert.rejects(
      () => deployBundle({ project_id: "prj_123_1" }, "https://api.run402.com"),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 400 && err.message.includes("not active"),
    );
  });

  it("throws 403 when wallet does not own the project", async () => {
    mockGetProjectById = async () => makeProject({ walletAddress: "0xOwnerWallet" });

    await assert.rejects(
      () => deployBundle({ project_id: "prj_123_1" }, "https://api.run402.com", "0xDifferentWallet"),
      (err: InstanceType<typeof BundleError>) => err.statusCode === 403 && err.message.includes("Wallet"),
    );
  });

  it("allows deploy when wallet matches (case-insensitive)", async () => {
    mockGetProjectById = async () => makeProject({ walletAddress: "0xABCD1234" });

    const result = await deployBundle(
      { project_id: "prj_123_1" },
      "https://api.run402.com",
      "0xabcd1234",
    );
    assert.equal(result.project_id, "prj_123_1");
  });

  it("allows deploy when no walletAddress on caller (admin/service key)", async () => {
    mockGetProjectById = async () => makeProject({ walletAddress: "0xABCD1234" });

    const result = await deployBundle(
      { project_id: "prj_123_1" },
      "https://api.run402.com",
      undefined,
    );
    assert.equal(result.project_id, "prj_123_1");
  });
});

describe("deployBundle — minimal deploy (project_id only)", () => {
  beforeEach(() => {
    mockGetProjectById = async () => makeProject();
    mockDeriveProjectKeys = () => ({ anonKey: "anon-key", serviceKey: "service-key" });
    mockDeployFunction = async () => ({ name: "test", url: "https://example.com/test" });
    mockSetSecret = async () => {};
    mockCreateDeployment = async () => ({ deployment_id: "dep_001", url: "https://sites.run402.com/dep_001" });
    mockCreateOrUpdateSubdomain = async () => ({ name: "test", deployment_id: "dep_001", project_id: "prj_123_1", created_at: "", updated_at: "" });
    mockPoolConnect = async () => ({
      query: async () => ({ rows: [] }),
      release: () => {},
    });
  });

  it("returns result with only project_id when no optional fields given", async () => {
    const result = await deployBundle(
      { project_id: "prj_123_1" },
      "https://api.run402.com",
    );

    assert.equal(result.project_id, "prj_123_1");
    assert.equal(result.site_url, undefined);
    assert.equal(result.deployment_id, undefined);
    assert.equal(result.functions, undefined);
    assert.equal(result.subdomain_url, undefined);
  });
});

describe("deployBundle — full deploy with all features", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const capturedCalls: { deployFunction: any[][]; setSecret: any[][]; createDeployment: any[][]; createOrUpdateSubdomain: any[][]; poolQueries: string[] } = {
    deployFunction: [],
    setSecret: [],
    createDeployment: [],
    createOrUpdateSubdomain: [],
    poolQueries: [],
  };

  beforeEach(() => {
    capturedCalls.deployFunction = [];
    capturedCalls.setSecret = [];
    capturedCalls.createDeployment = [];
    capturedCalls.createOrUpdateSubdomain = [];
    capturedCalls.poolQueries = [];

    mockGetProjectById = async () => makeProject({ walletAddress: "0xABCD1234" });
    mockDeriveProjectKeys = () => ({ anonKey: "anon-key", serviceKey: "service-key-xyz" });

    mockDeployFunction = async (...args) => {
      capturedCalls.deployFunction.push(args);
      const name = args[1] as string;
      return { name, url: `https://api.run402.com/fn/${name}` };
    };

    mockSetSecret = async (...args) => {
      capturedCalls.setSecret.push(args);
    };

    mockCreateDeployment = async (...args) => {
      capturedCalls.createDeployment.push(args);
      return { deployment_id: "dep_full_001", url: "https://sites.run402.com/dep_full_001" };
    };

    mockCreateOrUpdateSubdomain = async (...args) => {
      capturedCalls.createOrUpdateSubdomain.push(args);
      return { name: args[0], deployment_id: args[1], project_id: args[2], created_at: "", updated_at: "" };
    };

    mockPoolConnect = async () => ({
      query: async (q: string) => {
        capturedCalls.poolQueries.push(q);
        return { rows: [] };
      },
      release: () => {},
    });
  });

  it("orchestrates all steps and returns complete result", async () => {
    const result = await deployBundle(
      {
        project_id: "prj_123_1",
        migrations: "CREATE TABLE items (id serial PRIMARY KEY, name text);",
        rls: {
          template: "user_owns_rows",
          tables: [{ table: "items", owner_column: "user_id" }],
        },
        secrets: [
          { key: "OPENAI_API_KEY", value: "sk-test-123" },
          { key: "STRIPE_KEY", value: "sk-stripe-456" },
        ],
        functions: [
          { name: "checkout", code: 'export default async (req) => new Response("ok")' },
          { name: "webhook", code: 'export default async (req) => new Response("received")' },
        ],
        files: [
          { file: "index.html", data: "<h1>My App</h1>" },
          { file: "style.css", data: "body { margin: 0; }" },
        ],
        subdomain: "myapp",
      },
      "https://api.run402.com",
      "0xabcd1234",
    );

    // Verify result shape
    assert.equal(result.project_id, "prj_123_1");
    assert.equal(result.site_url, "https://myapp.run402.com");
    assert.equal(result.deployment_id, "dep_full_001");
    assert.equal(result.subdomain_url, "https://myapp.run402.com");
    assert.ok(result.functions);
    assert.equal(result.functions!.length, 2);
    assert.equal(result.functions![0].name, "checkout");
    assert.equal(result.functions![1].name, "webhook");

    // Verify migrations were run (BEGIN, SET search_path, SQL, NOTIFY, COMMIT)
    assert.ok(capturedCalls.poolQueries.some((q) => q.includes("BEGIN")));
    assert.ok(capturedCalls.poolQueries.some((q) => q.includes("search_path")));
    assert.ok(capturedCalls.poolQueries.some((q) => q.includes("CREATE TABLE items")));
    assert.ok(capturedCalls.poolQueries.some((q) => q.includes("NOTIFY")));
    assert.ok(capturedCalls.poolQueries.some((q) => q.includes("COMMIT")));

    // Verify RLS was applied (separate pool.connect call for RLS)
    assert.ok(capturedCalls.poolQueries.some((q) => q.includes("ROW LEVEL SECURITY")));
    assert.ok(capturedCalls.poolQueries.some((q) => q.includes("user_owns_rows") || q.includes("auth.uid()")));

    // Verify secrets were set
    assert.equal(capturedCalls.setSecret.length, 2);
    assert.equal(capturedCalls.setSecret[0][1], "OPENAI_API_KEY");
    assert.equal(capturedCalls.setSecret[0][2], "sk-test-123");
    assert.equal(capturedCalls.setSecret[1][1], "STRIPE_KEY");
    assert.equal(capturedCalls.setSecret[1][2], "sk-stripe-456");

    // Verify functions were deployed with correct args
    assert.equal(capturedCalls.deployFunction.length, 2);
    assert.equal(capturedCalls.deployFunction[0][0], "prj_123_1"); // projectId
    assert.equal(capturedCalls.deployFunction[0][1], "checkout"); // name
    assert.equal(capturedCalls.deployFunction[0][3], "service-key-xyz"); // serviceKey
    assert.equal(capturedCalls.deployFunction[0][4], "https://api.run402.com"); // apiBase

    // Verify site deployment
    assert.equal(capturedCalls.createDeployment.length, 1);
    assert.equal(capturedCalls.createDeployment[0][0].project, "prj_123_1");
    assert.equal(capturedCalls.createDeployment[0][0].files.length, 2);

    // Verify subdomain was claimed
    assert.equal(capturedCalls.createOrUpdateSubdomain.length, 1);
    assert.equal(capturedCalls.createOrUpdateSubdomain[0][0], "myapp");
    assert.equal(capturedCalls.createOrUpdateSubdomain[0][1], "dep_full_001");
    assert.equal(capturedCalls.createOrUpdateSubdomain[0][2], "prj_123_1");
    assert.equal(capturedCalls.createOrUpdateSubdomain[0][3], "0xabcd1234");
  });

  it("deploys functions without files or subdomain", async () => {
    const result = await deployBundle(
      {
        project_id: "prj_123_1",
        functions: [
          { name: "handler", code: 'export default async (req) => new Response("ok")' },
        ],
      },
      "https://api.run402.com",
    );

    assert.equal(result.project_id, "prj_123_1");
    assert.ok(result.functions);
    assert.equal(result.functions!.length, 1);
    assert.equal(result.functions![0].name, "handler");
    assert.equal(result.site_url, undefined);
    assert.equal(result.deployment_id, undefined);
    assert.equal(capturedCalls.createDeployment.length, 0);
    assert.equal(capturedCalls.createOrUpdateSubdomain.length, 0);
  });

  it("deploys files without subdomain — no subdomain_url in result", async () => {
    const result = await deployBundle(
      {
        project_id: "prj_123_1",
        files: [{ file: "index.html", data: "<h1>Hello</h1>" }],
      },
      "https://api.run402.com",
    );

    assert.equal(result.project_id, "prj_123_1");
    assert.equal(result.site_url, "https://sites.run402.com/dep_full_001");
    assert.equal(result.deployment_id, "dep_full_001");
    assert.equal(result.subdomain_url, undefined);
    assert.equal(capturedCalls.createOrUpdateSubdomain.length, 0);
  });

  it("does not claim subdomain when files are absent even if subdomain is specified", async () => {
    const result = await deployBundle(
      {
        project_id: "prj_123_1",
        subdomain: "orphan",
      },
      "https://api.run402.com",
    );

    // subdomain is set in request but no files, so createOrUpdateSubdomain is not called
    assert.equal(capturedCalls.createOrUpdateSubdomain.length, 0);
    // subdomain_url is still populated from req.subdomain
    assert.equal(result.subdomain_url, "https://orphan.run402.com");
  });
});

describe("deployBundle — migration SQL errors", () => {
  it("wraps SQL errors as BundleError 422 and rolls back", async () => {
    mockGetProjectById = async () => makeProject();
    mockDeriveProjectKeys = () => ({ anonKey: "anon-key", serviceKey: "service-key" });

    let rolledBack = false;
    let released = false;

    mockPoolConnect = async () => {
      let callCount = 0;
      return {
        query: async (q: string) => {
          callCount++;
          // Let BEGIN and SET search_path pass, fail on the migration SQL (3rd call)
          if (callCount === 3) {
            throw new Error('relation "nonexistent" does not exist');
          }
          // After error, ROLLBACK is called — track it
          if (typeof q === "string" && q.includes("ROLLBACK")) {
            rolledBack = true;
          }
          return { rows: [] };
        },
        release: () => { released = true; },
      };
    };

    await assert.rejects(
      () =>
        deployBundle(
          {
            project_id: "prj_123_1",
            migrations: "INSERT INTO nonexistent VALUES (1);",
          },
          "https://api.run402.com",
        ),
      (err: InstanceType<typeof BundleError>) => {
        return (
          err.statusCode === 422 &&
          err.message.includes("Migration SQL error") &&
          err.message.includes("nonexistent")
        );
      },
    );

    assert.ok(rolledBack, "Transaction should have been rolled back");
    assert.ok(released, "Client should have been released");
  });
});

describe("deployBundle — RLS template application via pool", () => {
  beforeEach(() => {
    mockGetProjectById = async () => makeProject();
    mockDeriveProjectKeys = () => ({ anonKey: "anon-key", serviceKey: "service-key" });
    mockDeployFunction = async () => ({ name: "test", url: "https://example.com/test" });
    mockSetSecret = async () => {};
    mockCreateDeployment = async () => ({ deployment_id: "dep_001", url: "https://sites.run402.com/dep_001" });
    mockCreateOrUpdateSubdomain = async () => ({ name: "test", deployment_id: "dep_001", project_id: "prj_123_1", created_at: "", updated_at: "" });
  });

  it("applies public_read template with correct policies", async () => {
    const queries: string[] = [];
    mockPoolConnect = async () => ({
      query: async (q: string) => {
        queries.push(q);
        // For pg_policies query, return empty rows (no existing policies)
        if (q.includes("pg_policies")) return { rows: [] };
        return { rows: [] };
      },
      release: () => {},
    });

    await deployBundle(
      {
        project_id: "prj_123_1",
        rls: { template: "public_read", tables: [{ table: "notes" }] },
      },
      "https://api.run402.com",
    );

    assert.ok(queries.some((q) => q.includes("ENABLE ROW LEVEL SECURITY")));
    assert.ok(queries.some((q) => q.includes("FORCE ROW LEVEL SECURITY")));
    assert.ok(queries.some((q) => q.includes("Anyone can read")));
    assert.ok(queries.some((q) => q.includes("Authenticated users can insert")));
    assert.ok(queries.some((q) => q.includes("Authenticated users can update")));
    assert.ok(queries.some((q) => q.includes("Authenticated users can delete")));
  });

  it("applies public_read_write template with anon grants", async () => {
    const queries: string[] = [];
    mockPoolConnect = async () => ({
      query: async (q: string) => {
        queries.push(q);
        if (q.includes("pg_policies")) return { rows: [] };
        return { rows: [] };
      },
      release: () => {},
    });

    await deployBundle(
      {
        project_id: "prj_123_1",
        rls: { template: "public_read_write", tables: [{ table: "comments" }] },
      },
      "https://api.run402.com",
    );

    assert.ok(queries.some((q) => q.includes("GRANT INSERT, UPDATE, DELETE")));
    assert.ok(queries.some((q) => q.includes("anon")));
    assert.ok(queries.some((q) => q.includes("Anyone can read")));
    assert.ok(queries.some((q) => q.includes("Anyone can insert")));
    assert.ok(queries.some((q) => q.includes("Anyone can update")));
    assert.ok(queries.some((q) => q.includes("Anyone can delete")));
  });

  it("drops existing policies before applying new ones (idempotent redeploy)", async () => {
    const queries: string[] = [];
    mockPoolConnect = async () => ({
      query: async (q: string) => {
        queries.push(q);
        if (q.includes("pg_policies")) {
          return { rows: [{ policyname: "old_policy_1" }, { policyname: "old_policy_2" }] };
        }
        return { rows: [] };
      },
      release: () => {},
    });

    await deployBundle(
      {
        project_id: "prj_123_1",
        rls: { template: "public_read", tables: [{ table: "posts" }] },
      },
      "https://api.run402.com",
    );

    assert.ok(queries.some((q) => q.includes("DROP POLICY") && q.includes("old_policy_1")));
    assert.ok(queries.some((q) => q.includes("DROP POLICY") && q.includes("old_policy_2")));
  });

  it("applies user_owns_rows with owner_column-based policies", async () => {
    const queries: string[] = [];
    mockPoolConnect = async () => ({
      query: async (q: string) => {
        queries.push(q);
        if (q.includes("pg_policies")) return { rows: [] };
        return { rows: [] };
      },
      release: () => {},
    });

    await deployBundle(
      {
        project_id: "prj_123_1",
        rls: {
          template: "user_owns_rows",
          tables: [{ table: "tasks", owner_column: "created_by" }],
        },
      },
      "https://api.run402.com",
    );

    assert.ok(queries.some((q) => q.includes("created_by") && q.includes("auth.uid()")));
    assert.ok(queries.some((q) => q.includes("Users can view own rows")));
    assert.ok(queries.some((q) => q.includes("Users can insert own rows")));
    assert.ok(queries.some((q) => q.includes("Users can update own rows")));
    assert.ok(queries.some((q) => q.includes("Users can delete own rows")));
  });

  it("applies RLS to multiple tables", async () => {
    const queries: string[] = [];
    mockPoolConnect = async () => ({
      query: async (q: string) => {
        queries.push(q);
        if (q.includes("pg_policies")) return { rows: [] };
        return { rows: [] };
      },
      release: () => {},
    });

    await deployBundle(
      {
        project_id: "prj_123_1",
        rls: {
          template: "user_owns_rows",
          tables: [
            { table: "posts", owner_column: "author_id" },
            { table: "comments", owner_column: "user_id" },
          ],
        },
      },
      "https://api.run402.com",
    );

    // Should have RLS enabled for both tables
    const rlsQueries = queries.filter((q) => q.includes("ENABLE ROW LEVEL SECURITY"));
    assert.ok(rlsQueries.length >= 2, "RLS should be enabled on both tables");
  });
});
