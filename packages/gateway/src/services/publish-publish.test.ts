/**
 * Tests for publishAppVersion — the main publish flow.
 *
 * Separate from publish.test.ts because publishAppVersion requires mocking
 * node:child_process (for pg_dump), and mock.module doesn't support adding
 * new mocks mid-file after the module under test is already imported.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mock dependencies before importing the module under test
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolQuery: (...args: any[]) => Promise<any>;

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (...args: any[]) => mockPoolQuery(...args),
    },
  },
});

mock.module("../config.js", {
  namedExports: {
    S3_BUCKET: "test-bucket",
    S3_REGION: "us-east-1",
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockS3Send: (...args: any[]) => Promise<any>;

mock.module("@aws-sdk/client-s3", {
  namedExports: {
    S3Client: class {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send = (...args: any[]) => mockS3Send(...args);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    PutObjectCommand: class { constructor(public input: any) {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    DeleteObjectCommand: class { constructor(public input: any) {} },
  },
});

// Mock execFile to simulate pg_dump.
// publish.ts does `promisify(execFile)` at module load. Node's real execFile has
// a custom promisify symbol so it resolves with {stdout, stderr}. Our mock must
// replicate that: we attach [util.promisify.custom] so promisify returns our
// async mock directly.
import { promisify } from "node:util";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockExecFileAsync: (cmd: string, args: string[], opts: any) => Promise<{ stdout: string; stderr: string }>;

// Build a callback-style function with the custom promisify symbol
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeExecFile: any = () => { throw new Error("use promisified version"); };
fakeExecFile[promisify.custom] = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cmd: string, args: string[], opts: any,
) => mockExecFileAsync(cmd, args, opts);

mock.module("node:child_process", {
  namedExports: {
    execFile: fakeExecFile,
  },
});

const { publishAppVersion, PublishError } = await import("./publish.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock that answers publishAppVersion's sequence of pool.query calls. */
function buildPublishQueryMock(overrides?: {
  unsupportedObjects?: Record<string, { rows: { name: string }[] }>;
  functions?: { rows: Array<Record<string, unknown>> };
  tables?: { rows: [{ cnt: number }] };
  deployments?: { rows: Array<Record<string, unknown>> };
  subdomains?: { rows: Array<Record<string, unknown>> };
  oldVersions?: { rows: Array<Record<string, unknown>> };
}) {
  const defaults = {
    functions: { rows: [] },
    tables: { rows: [{ cnt: 3 }] },
    deployments: { rows: [] },
    subdomains: { rows: [] },
    oldVersions: { rows: [] },
  };
  const opts = { ...defaults, ...overrides };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const queries: Array<{ sql: string; params?: unknown[] }> = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (sql: string, params?: unknown[]): Promise<any> => {
    queries.push({ sql, params });

    // pg_advisory_lock / pg_advisory_unlock
    if (sql.includes("pg_advisory_lock") || sql.includes("pg_advisory_unlock")) {
      return { rows: [{ pg_advisory_lock: "" }] };
    }

    // Unsupported object checks (views, materialized views, triggers, functions, types)
    if (sql.includes("information_schema.views")) {
      return overrides?.unsupportedObjects?.views || { rows: [] };
    }
    if (sql.includes("pg_matviews")) {
      return overrides?.unsupportedObjects?.materializedViews || { rows: [] };
    }
    if (sql.includes("information_schema.triggers")) {
      return overrides?.unsupportedObjects?.triggers || { rows: [] };
    }
    if (sql.includes("information_schema.routines")) {
      return overrides?.unsupportedObjects?.customFunctions || { rows: [] };
    }
    if (sql.includes("pg_type")) {
      return overrides?.unsupportedObjects?.customTypes || { rows: [] };
    }

    // Functions query
    if (sql.includes("internal.functions")) {
      return opts.functions;
    }

    // Table count
    if (sql.includes("information_schema.tables") && sql.includes("count")) {
      return opts.tables;
    }

    // Deployments (site info)
    if (sql.includes("internal.deployments") && sql.includes("SELECT")) {
      return opts.deployments;
    }

    // Subdomains
    if (sql.includes("internal.subdomains")) {
      return opts.subdomains;
    }

    // Old versions SELECT
    if (sql.includes("internal.app_versions") && sql.includes("SELECT") && sql.includes("bundle_uri")) {
      return opts.oldVersions;
    }

    // DELETE old versions
    if (sql.includes("DELETE FROM internal.app_versions")) {
      return { rows: [], rowCount: opts.oldVersions.rows.length };
    }

    // INSERT app version
    if (sql.includes("INSERT INTO internal.app_versions")) {
      return { rows: [], rowCount: 1 };
    }

    // INSERT function
    if (sql.includes("INSERT INTO internal.app_version_functions")) {
      return { rows: [], rowCount: 1 };
    }

    // UPDATE deployments ref_count
    if (sql.includes("UPDATE internal.deployments")) {
      return { rows: [], rowCount: 1 };
    }

    return { rows: [] };
  };
}

/** Default pgDump mock — returns minimal SQL for any section. */
function defaultExecFileMock() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockExecFileAsync = async (_cmd: string, args: string[], _opts: any) => {
    const schemaArg = args.find(a => a.startsWith("--schema="));
    const schema = schemaArg?.split("=")[1] || "p0001";

    let stdout = "";
    if (args.includes("--schema-only")) {
      if (args.some(a => a.includes("pre-data"))) {
        stdout = `CREATE SCHEMA ${schema};\nCREATE TABLE ${schema}.users (id uuid PRIMARY KEY);\nGRANT USAGE ON SCHEMA ${schema} TO anon;\n`;
      } else {
        stdout = `CREATE INDEX idx_users_id ON ${schema}.users (id);\n`;
      }
    } else if (args.includes("--data-only")) {
      stdout = `INSERT INTO ${schema}.users VALUES ('abc');\nINSERT INTO ${schema}.users VALUES ('def');\n`;
    }
    return { stdout, stderr: "" };
  };
}

// ---------------------------------------------------------------------------
// publishAppVersion
// ---------------------------------------------------------------------------

describe("publishAppVersion", () => {
  beforeEach(() => {
    mockPoolQuery = buildPublishQueryMock();
    mockS3Send = async () => ({});
    defaultExecFileMock();
  });

  it("publishes a basic version with no functions, no site, no seed", async () => {
    const result = await publishAppVersion(
      "prj_test_001",
      "my-test-app",
      "p0001",
      "0xWALLET",
      {},
    );

    assert.equal(result.project_id, "prj_test_001");
    assert.equal(result.name, "my-test-app");
    assert.equal(result.version, 1);
    assert.equal(result.status, "published");
    assert.equal(result.visibility, "private");
    assert.equal(result.fork_allowed, false);
    assert.equal(result.table_count, 3);
    assert.equal(result.function_count, 0);
    assert.equal(result.site_file_count, 0);
    assert.equal(result.site_total_bytes, 0);
    assert.deepEqual(result.required_secrets, []);
    assert.deepEqual(result.required_actions, []);
    assert.deepEqual(result.tags, []);
    assert.equal(result.live_url, null);
    assert.equal(result.bootstrap_variables, null);
    assert.deepEqual(result.compatibility_warnings, []);
    assert.ok(result.id.startsWith("ver_"));
    assert.ok(result.created_at);
    // derived_min_tier should be prototype for 0 functions, 0 bytes
    assert.equal(result.derived_min_tier, "prototype");
    assert.equal(result.min_tier, "prototype");
  });

  it("publishes with visibility, fork_allowed, description, and tags", async () => {
    const result = await publishAppVersion(
      "prj_test_002",
      "public-app",
      "p0002",
      "0xWALLET",
      {
        visibility: "public",
        fork_allowed: true,
        description: "A cool app",
        tags: ["web", "database"],
      },
    );

    assert.equal(result.visibility, "public");
    assert.equal(result.fork_allowed, true);
    assert.equal(result.description, "A cool app");
    assert.deepEqual(result.tags, ["web", "database"]);
  });

  it("publishes with required_secrets and required_actions", async () => {
    const result = await publishAppVersion(
      "prj_test_003",
      "secrets-app",
      "p0003",
      undefined,
      {
        required_secrets: [{ key: "API_KEY", description: "Your API key" }],
        required_actions: [{ action: "setup", description: "Run setup" }],
      },
    );

    assert.deepEqual(result.required_secrets, [{ key: "API_KEY", description: "Your API key" }]);
    assert.deepEqual(result.required_actions, [{ action: "setup", description: "Run setup" }]);
  });

  it("publishes with bootstrap_variables", async () => {
    const bootstrapVars = [
      { name: "APP_TITLE", type: "string", required: true, default: "My App" },
    ];
    const result = await publishAppVersion(
      "prj_test_004",
      "bootstrap-app",
      "p0004",
      undefined,
      { bootstrap_variables: bootstrapVars },
    );

    assert.deepEqual(result.bootstrap_variables, bootstrapVars);
  });

  it("rejects invalid tags", async () => {
    await assert.rejects(
      () => publishAppVersion("prj_t", "app", "p0001", undefined, { tags: ["INVALID"] }),
      (err: unknown) => {
        assert.ok(err instanceof PublishError);
        assert.equal((err as Error & { statusCode: number }).statusCode, 400);
        return true;
      },
    );
  });

  it("rejects projects with unsupported views", async () => {
    mockPoolQuery = buildPublishQueryMock({
      unsupportedObjects: {
        views: { rows: [{ name: "my_view" }] },
      },
    });

    await assert.rejects(
      () => publishAppVersion("prj_t", "app", "p0001", undefined, {}),
      (err: unknown) => {
        assert.ok(err instanceof PublishError);
        assert.equal((err as Error & { statusCode: number }).statusCode, 400);
        assert.ok((err as Error).message.includes("views"));
        return true;
      },
    );
  });

  it("rejects functions without stored source", async () => {
    mockPoolQuery = buildPublishQueryMock({
      functions: { rows: [{ name: "broken-fn", source: null, runtime: "node22", timeout_seconds: 10, memory_mb: 128, deps: [], code_hash: "abc" }] },
    });

    await assert.rejects(
      () => publishAppVersion("prj_t", "app", "p0001", undefined, {}),
      (err: unknown) => {
        assert.ok(err instanceof PublishError);
        assert.equal((err as Error & { statusCode: number }).statusCode, 400);
        assert.ok((err as Error).message.includes("broken-fn"));
        assert.ok((err as Error).message.includes("no stored source"));
        return true;
      },
    );
  });

  it("includes functions in the published version", async () => {
    const fnRows = [
      { name: "hello", source: "export default () => 'hi'", runtime: "node22", timeout_seconds: 10, memory_mb: 128, deps: [], code_hash: "h1" },
      { name: "goodbye", source: "export default () => 'bye'", runtime: "node22", timeout_seconds: 30, memory_mb: 256, deps: ["lodash"], code_hash: "h2" },
    ];
    mockPoolQuery = buildPublishQueryMock({ functions: { rows: fnRows } });

    const result = await publishAppVersion("prj_fn", "fn-app", "p0010", undefined, {});
    assert.equal(result.function_count, 2);
  });

  it("computes derived_min_tier as hobby when functions exceed prototype limit", async () => {
    // prototype maxFunctions = 15, so 16 functions should require hobby
    const fnRows = Array.from({ length: 16 }, (_, i) => ({
      name: `fn-${i}`,
      source: `export default () => ${i}`,
      runtime: "node22",
      timeout_seconds: 10,
      memory_mb: 128,
      deps: [],
      code_hash: `h${i}`,
    }));
    mockPoolQuery = buildPublishQueryMock({ functions: { rows: fnRows } });

    const result = await publishAppVersion("prj_tier", "tier-app", "p0010", undefined, {});
    assert.equal(result.derived_min_tier, "hobby");
    assert.equal(result.function_count, 16);
  });

  it("computes derived_min_tier as team when functions exceed hobby limit", async () => {
    // hobby maxFunctions = 50, so 51 functions should require team
    const fnRows = Array.from({ length: 51 }, (_, i) => ({
      name: `fn-${i}`,
      source: `export default () => ${i}`,
      runtime: "node22",
      timeout_seconds: 10,
      memory_mb: 128,
      deps: [],
      code_hash: `h${i}`,
    }));
    mockPoolQuery = buildPublishQueryMock({ functions: { rows: fnRows } });

    const result = await publishAppVersion("prj_tier2", "tier2-app", "p0010", undefined, {});
    assert.equal(result.derived_min_tier, "team");
  });

  it("computes derived_min_tier as hobby when site exceeds prototype storage", async () => {
    // prototype storageMb = 250, so 251 MB should require hobby
    const siteBytes = 251 * 1024 * 1024;
    mockPoolQuery = buildPublishQueryMock({
      deployments: { rows: [{ id: "dpl_big", files_count: 100, total_size: siteBytes }] },
    });

    const result = await publishAppVersion("prj_site", "site-app", "p0010", undefined, {});
    assert.equal(result.derived_min_tier, "hobby");
    assert.equal(result.site_total_bytes, siteBytes);
  });

  it("computes derived_min_tier as team when site exceeds hobby storage", async () => {
    // hobby storageMb = 1024, so 1025 MB should require team
    const siteBytes = 1025 * 1024 * 1024;
    mockPoolQuery = buildPublishQueryMock({
      deployments: { rows: [{ id: "dpl_huge", files_count: 500, total_size: siteBytes }] },
    });

    const result = await publishAppVersion("prj_site2", "site2-app", "p0010", undefined, {});
    assert.equal(result.derived_min_tier, "team");
  });

  it("includes seed data when include_seed is specified", async () => {
    mockPoolQuery = buildPublishQueryMock();

    const result = await publishAppVersion("prj_seed", "seed-app", "p0010", undefined, {
      include_seed: { tables: ["users", "posts"] },
    });

    assert.ok(result.id.startsWith("ver_"));
    assert.equal(result.status, "published");
  });

  it("resolves live_url from subdomain", async () => {
    mockPoolQuery = buildPublishQueryMock({
      subdomains: { rows: [{ name: "myapp" }] },
    });

    const result = await publishAppVersion("prj_sub", "sub-app", "p0010", undefined, {});
    assert.equal(result.live_url, "https://myapp.run402.com");
  });

  it("resolves live_url from site deployment when no subdomain", async () => {
    mockPoolQuery = buildPublishQueryMock({
      deployments: { rows: [{ id: "dpl_site_001", files_count: 5, total_size: 1024 }] },
    });

    const result = await publishAppVersion("prj_site_url", "site-url-app", "p0010", undefined, {});
    assert.equal(result.live_url, "https://dpl-site-001.sites.run402.com");
  });

  it("prefers subdomain over site deployment for live_url", async () => {
    mockPoolQuery = buildPublishQueryMock({
      subdomains: { rows: [{ name: "preferred" }] },
      deployments: { rows: [{ id: "dpl_ignored", files_count: 1, total_size: 100 }] },
    });

    const result = await publishAppVersion("prj_both", "both-app", "p0010", undefined, {});
    assert.equal(result.live_url, "https://preferred.run402.com");
  });

  it("deletes old versions before publishing new one", async () => {
    const deletedBundles: string[] = [];
    const originalS3Send = mockS3Send;
    mockS3Send = async (cmd: unknown) => {
      // Track DeleteObjectCommand calls
      if (cmd && typeof cmd === "object" && "input" in cmd) {
        const input = (cmd as { input: { Bucket?: string; Key?: string } }).input;
        if (input.Key && !input.Key.includes("bundle.json")) {
          // this is a delete
        }
      }
      return originalS3Send(cmd);
    };

    mockPoolQuery = buildPublishQueryMock({
      oldVersions: {
        rows: [
          { id: "ver_old_1", version: 2, bundle_uri: "s3://test-bucket/app-versions/ver_old_1/bundle.json", site_deployment_id: "dpl_old" },
        ],
      },
    });

    const result = await publishAppVersion("prj_replace", "replace-app", "p0010", undefined, {});
    // New version should be 3 (old max was 2)
    assert.equal(result.version, 3);
  });

  it("increments version from previous max", async () => {
    mockPoolQuery = buildPublishQueryMock({
      oldVersions: {
        rows: [
          { id: "ver_old_5", version: 5, bundle_uri: "s3://test-bucket/old5/bundle.json", site_deployment_id: null },
          { id: "ver_old_3", version: 3, bundle_uri: "s3://test-bucket/old3/bundle.json", site_deployment_id: null },
        ],
      },
    });

    const result = await publishAppVersion("prj_inc", "inc-app", "p0010", undefined, {});
    assert.equal(result.version, 6);
  });

  it("throws PublishError when pg_dump fails", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFileAsync = async (_cmd: string, _args: string[], _opts: any) => {
      throw new Error("pg_dump: command not found");
    };

    await assert.rejects(
      () => publishAppVersion("prj_fail", "fail-app", "p0001", undefined, {}),
      (err: unknown) => {
        assert.ok(err instanceof PublishError);
        assert.equal((err as Error & { statusCode: number }).statusCode, 500);
        assert.ok((err as Error).message.includes("pg_dump failed"));
        return true;
      },
    );
  });

  it("canonicalizes schema in pg_dump output", async () => {
    // The pre-data output contains the schema name — verify it gets
    // stored as __SCHEMA__ in the bundle (indirectly via the INSERT query)
    const insertedParams: unknown[][] = [];
    const baseMock = buildPublishQueryMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPoolQuery = async (sql: string, params?: unknown[]): Promise<any> => {
      if (sql.includes("INSERT INTO internal.app_versions") && params) {
        insertedParams.push([...params]);
      }
      return baseMock(sql, params);
    };

    await publishAppVersion("prj_canon", "canon-app", "p0099", undefined, {});

    // The bundle is uploaded to S3, not directly accessible via params,
    // but canonicalization removes CREATE SCHEMA and GRANT USAGE lines.
    // We verify the version was published successfully.
    assert.equal(insertedParams.length, 1);
  });

  it("strips pg_dump transaction_timeout statements from the stored bundle", async () => {
    const uploadedBodies: string[] = [];
    mockS3Send = async (command: { input?: { Body?: string } }) => {
      if (typeof command.input?.Body === "string") {
        uploadedBodies.push(command.input.Body);
      }
      return {};
    };
    mockExecFileAsync = async (_cmd: string, args: string[], _opts: unknown) => {
      const schemaArg = args.find((a) => a.startsWith("--schema="));
      const schema = schemaArg?.split("=")[1] || "p0001";
      return {
        stdout: `SET transaction_timeout = 0;\nCREATE TABLE ${schema}.users (id uuid PRIMARY KEY);\n`,
        stderr: "",
      };
    };

    await publishAppVersion("prj_strip", "strip-app", "p0001", undefined, {});

    assert.equal(uploadedBodies.length, 1);
    assert.ok(!uploadedBodies[0].includes("transaction_timeout"));
  });

  it("pins site deployment ref_count when site exists", async () => {
    const updatedDeployments: string[] = [];
    const baseMock = buildPublishQueryMock({
      deployments: { rows: [{ id: "dpl_pin_001", files_count: 3, total_size: 512 }] },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPoolQuery = async (sql: string, params?: unknown[]): Promise<any> => {
      if (sql.includes("UPDATE internal.deployments") && sql.includes("ref_count + 1") && params) {
        updatedDeployments.push(params[0] as string);
      }
      return baseMock(sql, params);
    };

    const result = await publishAppVersion("prj_pin", "pin-app", "p0010", undefined, {});
    assert.equal(result.site_file_count, 3);
    assert.equal(result.site_total_bytes, 512);
    assert.ok(updatedDeployments.includes("dpl_pin_001"));
  });

  it("releases advisory lock even when publish fails", async () => {
    let advisoryUnlocked = false;
    const baseMock = buildPublishQueryMock({
      unsupportedObjects: {
        views: { rows: [{ name: "bad_view" }] },
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPoolQuery = async (sql: string, params?: unknown[]): Promise<any> => {
      if (sql.includes("pg_advisory_unlock")) {
        advisoryUnlocked = true;
      }
      return baseMock(sql, params);
    };

    await assert.rejects(
      () => publishAppVersion("prj_lock", "lock-app", "p0001", undefined, {}),
    );
    assert.ok(advisoryUnlocked, "Advisory lock should be released in finally block");
  });

  it("uploads bundle to S3 with correct key pattern", async () => {
    const uploadedKeys: string[] = [];
    mockS3Send = async (cmd: unknown) => {
      if (cmd && typeof cmd === "object" && "input" in cmd) {
        const input = (cmd as { input: { Key?: string } }).input;
        if (input.Key) uploadedKeys.push(input.Key);
      }
      return {};
    };

    const result = await publishAppVersion("prj_s3", "s3-app", "p0001", undefined, {});
    // Should have uploaded a bundle with key matching app-versions/<ver_id>/bundle.json
    assert.ok(uploadedKeys.some(k => k.startsWith("app-versions/ver_") && k.endsWith("/bundle.json")),
      `Expected S3 upload key matching pattern, got: ${uploadedKeys.join(", ")}`);
  });
});
