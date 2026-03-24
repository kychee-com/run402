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
    S3_BUCKET: undefined,
    S3_REGION: "us-east-1",
  },
});

mock.module("@aws-sdk/client-s3", {
  namedExports: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    S3Client: class { send = async () => ({}); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    PutObjectCommand: class { constructor(public input: any) {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    DeleteObjectCommand: class { constructor(public input: any) {} },
  },
});

const {
  validateTags,
  decanonicalizeSchema,
  listVersions,
  listPublicApps,
  getAppVersion,
  deleteAppVersion,
  PublishError,
  initAppVersionsTables,
} = await import("./publish.js");

// ---------------------------------------------------------------------------
// validateTags — pure function
// ---------------------------------------------------------------------------

describe("validateTags", () => {
  it("returns null for valid tags", () => {
    assert.equal(validateTags(["web", "database", "ai-tools"]), null);
  });

  it("returns null for empty array", () => {
    assert.equal(validateTags([]), null);
  });

  it("returns null for exactly MAX_TAGS (10) tags", () => {
    const tags = Array.from({ length: 10 }, (_, i) => `tag-${String(i).padStart(2, "0")}`);
    assert.equal(validateTags(tags), null);
  });

  it("rejects more than 10 tags", () => {
    const tags = Array.from({ length: 11 }, (_, i) => `tag-${String(i).padStart(2, "0")}`);
    const err = validateTags(tags);
    assert.ok(err);
    assert.ok(err.includes("10"));
  });

  it("rejects non-array input", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = validateTags("not-an-array" as any);
    assert.ok(err);
    assert.ok(err.includes("array"));
  });

  it("rejects non-string tag", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = validateTags([123 as any]);
    assert.ok(err);
    assert.ok(err.includes("string"));
  });

  it("rejects tag shorter than 2 characters", () => {
    const err = validateTags(["a"]);
    assert.ok(err);
    assert.ok(err.includes("too short"));
  });

  it("rejects empty string tag", () => {
    const err = validateTags([""]);
    assert.ok(err);
    assert.ok(err.includes("too short"));
  });

  it("rejects tag with uppercase letters", () => {
    const err = validateTags(["Hello"]);
    assert.ok(err);
    assert.ok(err.includes("lowercase"));
  });

  it("rejects tag with spaces", () => {
    const err = validateTags(["my tag"]);
    assert.ok(err);
    assert.ok(err.includes("lowercase"));
  });

  it("rejects tag with underscores", () => {
    const err = validateTags(["my_tag"]);
    assert.ok(err);
    assert.ok(err.includes("lowercase"));
  });

  it("rejects tag starting with hyphen", () => {
    const err = validateTags(["-tag"]);
    assert.ok(err);
    assert.ok(err.includes("lowercase"));
  });

  it("rejects tag ending with hyphen", () => {
    const err = validateTags(["tag-"]);
    assert.ok(err);
    assert.ok(err.includes("lowercase"));
  });

  it("rejects duplicate tags", () => {
    const err = validateTags(["web", "api", "web"]);
    assert.ok(err);
    assert.ok(err.includes("Duplicate"));
  });

  it("accepts 2-char tag (minimum valid)", () => {
    assert.equal(validateTags(["ab"]), null);
  });

  it("accepts 30-char tag (maximum valid)", () => {
    // 30 chars: first char + 28 middle + last char
    const tag = "a" + "b".repeat(28) + "c";
    assert.equal(tag.length, 30);
    assert.equal(validateTags([tag]), null);
  });

  it("rejects 31-char tag (exceeds max)", () => {
    const tag = "a" + "b".repeat(29) + "c";
    assert.equal(tag.length, 31);
    const err = validateTags([tag]);
    assert.ok(err);
    assert.ok(err.includes("lowercase"));
  });

  it("accepts tags with hyphens in the middle", () => {
    assert.equal(validateTags(["my-cool-tag"]), null);
  });

  it("accepts tags with digits", () => {
    assert.equal(validateTags(["web3", "v2-api"]), null);
  });
});

// ---------------------------------------------------------------------------
// decanonicalizeSchema — pure function
// ---------------------------------------------------------------------------

describe("decanonicalizeSchema", () => {
  it("replaces __SCHEMA__ with target schema name", () => {
    const sql = `SET search_path = __SCHEMA__, public;
CREATE TABLE __SCHEMA__.users (id uuid PRIMARY KEY);
CREATE INDEX idx_users ON __SCHEMA__.users (id);`;

    const result = decanonicalizeSchema(sql, "p0099");

    assert.ok(result.includes("SET search_path = p0099, public"));
    assert.ok(result.includes("CREATE TABLE p0099.users"));
    assert.ok(result.includes("CREATE INDEX idx_users ON p0099.users"));
    assert.ok(!result.includes("__SCHEMA__"));
  });

  it("handles SQL with no placeholders", () => {
    assert.equal(decanonicalizeSchema("SELECT 1;", "p0001"), "SELECT 1;");
  });

  it("handles multiple occurrences on the same line", () => {
    const sql = "__SCHEMA__.__SCHEMA__.__SCHEMA__";
    assert.equal(decanonicalizeSchema(sql, "p0042"), "p0042.p0042.p0042");
  });

  it("handles empty string", () => {
    assert.equal(decanonicalizeSchema("", "p0001"), "");
  });

  it("preserves other content untouched", () => {
    const sql = "CREATE TABLE __SCHEMA__.orders (\n  id uuid PRIMARY KEY,\n  total numeric\n);";
    const result = decanonicalizeSchema(sql, "p0005");
    assert.ok(result.includes("id uuid PRIMARY KEY"));
    assert.ok(result.includes("total numeric"));
    assert.ok(result.startsWith("CREATE TABLE p0005.orders"));
  });

  it("works with schema names of varying lengths", () => {
    const sql = "__SCHEMA__.test";
    assert.equal(decanonicalizeSchema(sql, "p0001"), "p0001.test");
    assert.equal(decanonicalizeSchema(sql, "my_long_schema_name"), "my_long_schema_name.test");
  });
});

// ---------------------------------------------------------------------------
// initAppVersionsTables — DB interactions
// ---------------------------------------------------------------------------

describe("initAppVersionsTables", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
  });

  it("executes all DDL statements", async () => {
    const queries: string[] = [];
    mockPoolQuery = async (q: string) => {
      queries.push(q);
      return { rows: [] };
    };

    await initAppVersionsTables();

    // Should issue: CREATE TABLE app_versions, ALTER TABLE (bootstrap_variables), CREATE INDEX, CREATE TABLE app_version_functions
    assert.ok(queries.length >= 4, `Expected at least 4 queries, got ${queries.length}`);
    assert.ok(queries.some(q => q.includes("CREATE TABLE IF NOT EXISTS internal.app_versions")));
    assert.ok(queries.some(q => q.includes("bootstrap_variables")));
    assert.ok(queries.some(q => q.includes("CREATE INDEX IF NOT EXISTS idx_app_versions_project")));
    assert.ok(queries.some(q => q.includes("CREATE TABLE IF NOT EXISTS internal.app_version_functions")));
  });
});

// ---------------------------------------------------------------------------
// listVersions — DB query
// ---------------------------------------------------------------------------

describe("listVersions", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
  });

  it("returns empty array when no versions exist", async () => {
    mockPoolQuery = async () => ({ rows: [] });
    const versions = await listVersions("prj_123");
    assert.deepEqual(versions, []);
  });

  it("returns mapped versions ordered by version DESC", async () => {
    mockPoolQuery = async () => ({
      rows: [
        {
          id: "ver_001",
          project_id: "prj_123",
          version: 2,
          name: "my-app",
          description: "second version",
          visibility: "public",
          fork_allowed: true,
          min_tier: "hobby",
          derived_min_tier: "hobby",
          status: "published",
          table_count: 5,
          function_count: 3,
          site_file_count: 10,
          site_total_bytes: "1024",
          required_secrets: [{ key: "API_KEY" }],
          required_actions: [],
          tags: ["web", "ai"],
          live_url: "https://myapp.run402.com",
          bootstrap_variables: null,
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "ver_000",
          project_id: "prj_123",
          version: 1,
          name: "my-app",
          description: null,
          visibility: "private",
          fork_allowed: false,
          min_tier: "prototype",
          derived_min_tier: "prototype",
          status: "published",
          table_count: 2,
          function_count: 0,
          site_file_count: 1,
          site_total_bytes: 512,
          required_secrets: [],
          required_actions: [],
          tags: [],
          live_url: null,
          bootstrap_variables: null,
          created_at: "2025-12-01T00:00:00Z",
        },
      ],
    });

    const versions = await listVersions("prj_123");
    assert.equal(versions.length, 2);
    assert.equal(versions[0].id, "ver_001");
    assert.equal(versions[0].version, 2);
    assert.equal(versions[0].visibility, "public");
    assert.equal(versions[0].fork_allowed, true);
    assert.equal(versions[0].min_tier, "hobby");
    assert.equal(versions[0].table_count, 5);
    assert.equal(versions[0].site_total_bytes, 1024);
    assert.deepEqual(versions[0].tags, ["web", "ai"]);
    assert.deepEqual(versions[0].required_secrets, [{ key: "API_KEY" }]);
    assert.equal(versions[0].live_url, "https://myapp.run402.com");
    assert.deepEqual(versions[0].compatibility_warnings, []);

    assert.equal(versions[1].id, "ver_000");
    assert.equal(versions[1].version, 1);
    assert.equal(versions[1].description, null);
  });

  it("passes projectId as query parameter", async () => {
    let capturedParams: unknown[] | undefined;
    mockPoolQuery = async (_q: string, params?: unknown[]) => {
      capturedParams = params;
      return { rows: [] };
    };

    await listVersions("prj_abc_123");
    assert.deepEqual(capturedParams, ["prj_abc_123"]);
  });

  it("coerces site_total_bytes string to number", async () => {
    mockPoolQuery = async () => ({
      rows: [{
        id: "ver_x",
        project_id: "prj_1",
        version: 1,
        name: "test",
        description: null,
        visibility: "private",
        fork_allowed: false,
        min_tier: "prototype",
        derived_min_tier: "prototype",
        status: "published",
        table_count: 0,
        function_count: 0,
        site_file_count: 0,
        site_total_bytes: "999999",
        required_secrets: null,
        required_actions: null,
        tags: null,
        live_url: null,
        bootstrap_variables: null,
        created_at: "2026-01-01T00:00:00Z",
      }],
    });

    const versions = await listVersions("prj_1");
    assert.equal(typeof versions[0].site_total_bytes, "number");
    assert.equal(versions[0].site_total_bytes, 999999);
    // null coercion for required_secrets and tags
    assert.deepEqual(versions[0].required_secrets, []);
    assert.deepEqual(versions[0].required_actions, []);
    assert.deepEqual(versions[0].tags, []);
  });
});

// ---------------------------------------------------------------------------
// listPublicApps — DB query with optional tag filter
// ---------------------------------------------------------------------------

describe("listPublicApps", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
  });

  it("returns empty array when no public apps exist", async () => {
    const apps = await listPublicApps();
    assert.deepEqual(apps, []);
  });

  it("queries without tag filter when no tags provided", async () => {
    let capturedQuery = "";
    let capturedParams: unknown[] | undefined;
    mockPoolQuery = async (q: string, params?: unknown[]) => {
      capturedQuery = q;
      capturedParams = params;
      return { rows: [] };
    };

    await listPublicApps();
    assert.ok(capturedQuery.includes("visibility IN ('public', 'unlisted')"));
    assert.ok(capturedQuery.includes("status = 'published'"));
    assert.ok(!capturedQuery.includes("tags @>"));
    assert.equal(capturedParams, undefined);
  });

  it("queries without tag filter when empty tags array provided", async () => {
    let capturedQuery = "";
    let capturedParams: unknown[] | undefined;
    mockPoolQuery = async (q: string, params?: unknown[]) => {
      capturedQuery = q;
      capturedParams = params;
      return { rows: [] };
    };

    await listPublicApps([]);
    assert.ok(!capturedQuery.includes("tags @>"));
    assert.equal(capturedParams, undefined);
  });

  it("includes tag filter when tags are provided", async () => {
    let capturedQuery = "";
    let capturedParams: unknown[] | undefined;
    mockPoolQuery = async (q: string, params?: unknown[]) => {
      capturedQuery = q;
      capturedParams = params;
      return { rows: [] };
    };

    await listPublicApps(["web", "database"]);
    assert.ok(capturedQuery.includes("tags @> $1"));
    assert.deepEqual(capturedParams, [["web", "database"]]);
  });

  it("returns mapped versions for public apps", async () => {
    mockPoolQuery = async () => ({
      rows: [{
        id: "ver_pub_001",
        project_id: "prj_pub",
        version: 1,
        name: "public-app",
        description: "A public app",
        visibility: "public",
        fork_allowed: true,
        min_tier: "prototype",
        derived_min_tier: "prototype",
        status: "published",
        table_count: 3,
        function_count: 1,
        site_file_count: 5,
        site_total_bytes: 2048,
        required_secrets: [],
        required_actions: [],
        tags: ["web"],
        live_url: "https://public.run402.com",
        site_deployment_id: "dpl_123",
        bootstrap_variables: [{ name: "APP_NAME", type: "string" }],
        created_at: "2026-02-15T00:00:00Z",
      }],
    });

    const apps = await listPublicApps();
    assert.equal(apps.length, 1);
    assert.equal(apps[0].id, "ver_pub_001");
    assert.equal(apps[0].name, "public-app");
    assert.equal(apps[0].fork_allowed, true);
    assert.deepEqual(apps[0].tags, ["web"]);
    assert.deepEqual(apps[0].bootstrap_variables, [{ name: "APP_NAME", type: "string" }]);
  });

  it("includes ORDER BY created_at DESC LIMIT 100", async () => {
    let capturedQuery = "";
    mockPoolQuery = async (q: string) => {
      capturedQuery = q;
      return { rows: [] };
    };

    await listPublicApps();
    assert.ok(capturedQuery.includes("ORDER BY created_at DESC LIMIT 100"));
  });
});

// ---------------------------------------------------------------------------
// getAppVersion — single version lookup
// ---------------------------------------------------------------------------

describe("getAppVersion", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
  });

  it("returns null when version not found", async () => {
    mockPoolQuery = async () => ({ rows: [] });
    const result = await getAppVersion("ver_nonexistent");
    assert.equal(result, null);
  });

  it("returns mapped version when found", async () => {
    mockPoolQuery = async () => ({
      rows: [{
        id: "ver_found",
        project_id: "prj_owner",
        version: 3,
        name: "cool-app",
        description: "A cool app",
        visibility: "public",
        fork_allowed: true,
        min_tier: "hobby",
        derived_min_tier: "hobby",
        status: "published",
        table_count: 4,
        function_count: 2,
        site_file_count: 8,
        site_total_bytes: "4096",
        required_secrets: [{ key: "SECRET_KEY", description: "Auth secret" }],
        required_actions: [{ action: "setup-db", description: "Run migrations" }],
        tags: ["ai", "database"],
        live_url: "https://cool.run402.com",
        bootstrap_variables: [{ name: "TITLE", type: "string", required: true }],
        created_at: "2026-03-01T12:00:00Z",
      }],
    });

    const result = await getAppVersion("ver_found");
    assert.ok(result);
    assert.equal(result.id, "ver_found");
    assert.equal(result.project_id, "prj_owner");
    assert.equal(result.version, 3);
    assert.equal(result.name, "cool-app");
    assert.equal(result.description, "A cool app");
    assert.equal(result.visibility, "public");
    assert.equal(result.fork_allowed, true);
    assert.equal(result.min_tier, "hobby");
    assert.equal(result.derived_min_tier, "hobby");
    assert.equal(result.status, "published");
    assert.equal(result.table_count, 4);
    assert.equal(result.function_count, 2);
    assert.equal(result.site_file_count, 8);
    assert.equal(result.site_total_bytes, 4096);
    assert.deepEqual(result.required_secrets, [{ key: "SECRET_KEY", description: "Auth secret" }]);
    assert.deepEqual(result.required_actions, [{ action: "setup-db", description: "Run migrations" }]);
    assert.deepEqual(result.tags, ["ai", "database"]);
    assert.equal(result.live_url, "https://cool.run402.com");
    assert.deepEqual(result.bootstrap_variables, [{ name: "TITLE", type: "string", required: true }]);
    assert.equal(result.created_at, "2026-03-01T12:00:00Z");
    assert.deepEqual(result.compatibility_warnings, []);
  });

  it("passes versionId as query parameter", async () => {
    let capturedParams: unknown[] | undefined;
    mockPoolQuery = async (_q: string, params?: unknown[]) => {
      capturedParams = params;
      return { rows: [] };
    };

    await getAppVersion("ver_abc_123");
    assert.deepEqual(capturedParams, ["ver_abc_123"]);
  });

  it("handles null live_url gracefully", async () => {
    mockPoolQuery = async () => ({
      rows: [{
        id: "ver_no_url",
        project_id: "prj_1",
        version: 1,
        name: "no-url",
        description: null,
        visibility: "private",
        fork_allowed: false,
        min_tier: "prototype",
        derived_min_tier: "prototype",
        status: "published",
        table_count: 1,
        function_count: 0,
        site_file_count: 0,
        site_total_bytes: 0,
        required_secrets: null,
        required_actions: null,
        tags: null,
        live_url: null,
        bootstrap_variables: null,
        created_at: "2026-01-01T00:00:00Z",
      }],
    });

    const result = await getAppVersion("ver_no_url");
    assert.ok(result);
    assert.equal(result.live_url, null);
    assert.equal(result.description, null);
    assert.deepEqual(result.required_secrets, []);
    assert.deepEqual(result.tags, []);
    assert.equal(result.bootstrap_variables, null);
  });
});

// ---------------------------------------------------------------------------
// deleteAppVersion — DB + S3 cleanup
// ---------------------------------------------------------------------------

describe("deleteAppVersion", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
  });

  it("returns false when version not found", async () => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
    const result = await deleteAppVersion("ver_nope", "prj_123");
    assert.equal(result, false);
  });

  it("returns false when version exists but belongs to different project", async () => {
    // First query (SELECT) returns empty — version/project combo doesn't match
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
    const result = await deleteAppVersion("ver_123", "prj_wrong");
    assert.equal(result, false);
  });

  it("deletes version and returns true when found", async () => {
    let queryCount = 0;
    const executedQueries: string[] = [];

    mockPoolQuery = async (q: string) => {
      executedQueries.push(q);
      queryCount++;
      if (queryCount === 1) {
        // SELECT metadata
        return {
          rows: [{ site_deployment_id: null, bundle_uri: "s3://bucket/app-versions/ver_del/bundle.json" }],
        };
      }
      if (queryCount === 2) {
        // DELETE
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const result = await deleteAppVersion("ver_del", "prj_owner");
    assert.equal(result, true);
    assert.ok(executedQueries.some(q => q.includes("DELETE FROM internal.app_versions")));
  });

  it("decrements site deployment ref_count when version has site_deployment_id", async () => {
    let queryCount = 0;
    const executedQueries: { q: string; params?: unknown[] }[] = [];

    mockPoolQuery = async (q: string, params?: unknown[]) => {
      executedQueries.push({ q, params });
      queryCount++;
      if (queryCount === 1) {
        // SELECT metadata — has site deployment
        return {
          rows: [{
            site_deployment_id: "dpl_site_123",
            bundle_uri: "s3://bucket/app-versions/ver_del2/bundle.json",
          }],
        };
      }
      if (queryCount === 2) {
        // DELETE
        return { rows: [], rowCount: 1 };
      }
      // ref_count update
      return { rows: [], rowCount: 1 };
    };

    const result = await deleteAppVersion("ver_del2", "prj_owner");
    assert.equal(result, true);

    // Should have an UPDATE query for ref_count
    const refCountQuery = executedQueries.find(e => e.q.includes("ref_count"));
    assert.ok(refCountQuery, "Should decrement site deployment ref_count");
    assert.deepEqual(refCountQuery!.params, ["dpl_site_123"]);
  });

  it("does not decrement ref_count when no site_deployment_id", async () => {
    let queryCount = 0;
    const executedQueries: string[] = [];

    mockPoolQuery = async (q: string) => {
      executedQueries.push(q);
      queryCount++;
      if (queryCount === 1) {
        // SELECT metadata — no site deployment
        return {
          rows: [{ site_deployment_id: null, bundle_uri: "s3://bucket/ver/bundle.json" }],
        };
      }
      if (queryCount === 2) {
        // DELETE
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    await deleteAppVersion("ver_no_site", "prj_owner");

    const refCountQueries = executedQueries.filter(q => q.includes("ref_count"));
    assert.equal(refCountQueries.length, 0, "Should not issue ref_count update when no site deployment");
  });

  it("returns false when DELETE rowCount is 0 (race condition)", async () => {
    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) {
        // SELECT metadata — version exists
        return {
          rows: [{ site_deployment_id: null, bundle_uri: "s3://bucket/ver/bundle.json" }],
        };
      }
      // DELETE returns 0 rows (concurrent deletion)
      return { rows: [], rowCount: 0 };
    };

    const result = await deleteAppVersion("ver_race", "prj_owner");
    assert.equal(result, false);
  });

  it("passes correct parameters to SELECT and DELETE queries", async () => {
    let queryCount = 0;
    const capturedParams: { q: string; params?: unknown[] }[] = [];

    mockPoolQuery = async (q: string, params?: unknown[]) => {
      capturedParams.push({ q, params });
      queryCount++;
      if (queryCount === 1) {
        return { rows: [{ site_deployment_id: null, bundle_uri: "s3://b/k" }] };
      }
      return { rows: [], rowCount: 1 };
    };

    await deleteAppVersion("ver_param_test", "prj_param_test");

    // First query: SELECT with [versionId, projectId]
    assert.deepEqual(capturedParams[0].params, ["ver_param_test", "prj_param_test"]);
    // Second query: DELETE with [versionId, projectId]
    assert.deepEqual(capturedParams[1].params, ["ver_param_test", "prj_param_test"]);
  });
});

// ---------------------------------------------------------------------------
// PublishError — error class
// ---------------------------------------------------------------------------

describe("PublishError", () => {
  it("has message and statusCode", () => {
    const err = new PublishError("bad request", 400);
    assert.equal(err.message, "bad request");
    assert.equal(err.statusCode, 400);
    assert.ok(err instanceof Error);
  });

  it("supports different status codes", () => {
    const err500 = new PublishError("internal error", 500);
    assert.equal(err500.statusCode, 500);

    const err404 = new PublishError("not found", 404);
    assert.equal(err404.statusCode, 404);
  });
});

// ---------------------------------------------------------------------------
// mapRowToAppVersion — tested indirectly through getAppVersion/listVersions
// ---------------------------------------------------------------------------

describe("mapRowToAppVersion — edge cases via getAppVersion", () => {
  it("coerces falsy live_url to null", async () => {
    mockPoolQuery = async () => ({
      rows: [{
        id: "ver_1",
        project_id: "prj_1",
        version: 1,
        name: "test",
        description: null,
        visibility: "private",
        fork_allowed: false,
        min_tier: "prototype",
        derived_min_tier: "prototype",
        status: "published",
        table_count: 0,
        function_count: 0,
        site_file_count: 0,
        site_total_bytes: 0,
        required_secrets: [],
        required_actions: [],
        tags: [],
        live_url: "",
        bootstrap_variables: null,
        created_at: "2026-01-01T00:00:00Z",
      }],
    });

    const result = await getAppVersion("ver_1");
    assert.ok(result);
    // Empty string live_url should become null
    assert.equal(result.live_url, null);
  });

  it("coerces bigint-string site_total_bytes to number", async () => {
    mockPoolQuery = async () => ({
      rows: [{
        id: "ver_big",
        project_id: "prj_1",
        version: 1,
        name: "test",
        description: null,
        visibility: "private",
        fork_allowed: false,
        min_tier: "prototype",
        derived_min_tier: "prototype",
        status: "published",
        table_count: 0,
        function_count: 0,
        site_file_count: 0,
        site_total_bytes: "10737418240",
        required_secrets: [],
        required_actions: [],
        tags: [],
        live_url: null,
        bootstrap_variables: null,
        created_at: "2026-01-01T00:00:00Z",
      }],
    });

    const result = await getAppVersion("ver_big");
    assert.ok(result);
    assert.equal(typeof result.site_total_bytes, "number");
    assert.equal(result.site_total_bytes, 10737418240);
  });

  it("handles null/undefined optional fields gracefully", async () => {
    mockPoolQuery = async () => ({
      rows: [{
        id: "ver_nulls",
        project_id: "prj_1",
        version: 1,
        name: "test",
        description: null,
        visibility: "private",
        fork_allowed: false,
        min_tier: "prototype",
        derived_min_tier: "prototype",
        status: "published",
        table_count: 0,
        function_count: 0,
        site_file_count: 0,
        site_total_bytes: 0,
        required_secrets: null,
        required_actions: null,
        tags: null,
        live_url: null,
        bootstrap_variables: null,
        created_at: "2026-01-01T00:00:00Z",
      }],
    });

    const result = await getAppVersion("ver_nulls");
    assert.ok(result);
    assert.deepEqual(result.required_secrets, []);
    assert.deepEqual(result.required_actions, []);
    assert.deepEqual(result.tags, []);
    assert.equal(result.bootstrap_variables, null);
    assert.equal(result.live_url, null);
  });
});
