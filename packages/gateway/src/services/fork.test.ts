/**
 * Comprehensive unit tests for the fork service.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Mock dependencies before importing the module under test
// ---------------------------------------------------------------------------

let mockPoolQuery: (...args: any[]) => Promise<any>;
let mockPoolConnect: () => Promise<any>;

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      query: (...args: any[]) => mockPoolQuery(...args),
      connect: () => mockPoolConnect(),
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
    S3Client: class MockS3Client {},
    GetObjectCommand: class MockGetObjectCommand {},
  },
});

mock.module("./bundle.js", {
  namedExports: {
    deployBundle: async () => ({ project_id: "prj_123" }),
  },
});

mock.module("./projects.js", {
  namedExports: {
    createProject: async (name: string, tier: string) => ({
      id: "prj_new_001",
      name,
      tier,
      schemaSlot: "p0042",
    }),
    purgeProject: async () => true,
    deriveProjectKeys: (_projectId: string, _tier: string) => ({
      anonKey: "anon-key-abc",
      serviceKey: "service-key-xyz",
    }),
  },
});

mock.module("./publish.js", {
  namedExports: {
    decanonicalizeSchema: (sql: string, schema: string) =>
      sql.replace(/__SCHEMA__/g, schema),
  },
});

const {
  ForkError,
  validateForkRequest,
  forkApp,
  executeSqlViaPsql,
} = await import("./fork.js");

// ---------------------------------------------------------------------------
// ForkError
// ---------------------------------------------------------------------------

describe("ForkError", () => {
  it("has message and statusCode", () => {
    const err = new ForkError("not found", 404);
    assert.equal(err.message, "not found");
    assert.equal(err.statusCode, 404);
    assert.ok(err instanceof Error);
  });

  it("works with different status codes", () => {
    const err400 = new ForkError("bad request", 400);
    assert.equal(err400.statusCode, 400);

    const err503 = new ForkError("unavailable", 503);
    assert.equal(err503.statusCode, 503);
  });
});

// ---------------------------------------------------------------------------
// validateForkRequest
// ---------------------------------------------------------------------------

describe("validateForkRequest", () => {
  it("rejects missing version_id (empty string)", () => {
    assert.throws(
      () => validateForkRequest({ version_id: "", name: "app" }),
      (err: any) => err instanceof ForkError && err.statusCode === 400 && err.message.includes("version_id"),
    );
  });

  it("rejects non-string version_id", () => {
    assert.throws(
      () => validateForkRequest({ version_id: 123 as unknown as string, name: "app" }),
      (err: any) => err instanceof ForkError && err.statusCode === 400,
    );
  });

  it("rejects missing name (empty string)", () => {
    assert.throws(
      () => validateForkRequest({ version_id: "ver_123", name: "" }),
      (err: any) => err instanceof ForkError && err.statusCode === 400 && err.message.includes("name"),
    );
  });

  it("rejects non-string name", () => {
    assert.throws(
      () => validateForkRequest({ version_id: "ver_123", name: 42 as unknown as string }),
      (err: any) => err instanceof ForkError && err.statusCode === 400,
    );
  });

  it("accepts valid request", () => {
    assert.doesNotThrow(() =>
      validateForkRequest({ version_id: "ver_1741340000_abc123", name: "my-fork" }),
    );
  });

  it("accepts request with optional subdomain", () => {
    assert.doesNotThrow(() =>
      validateForkRequest({
        version_id: "ver_123",
        name: "my-fork",
        subdomain: "cool-app",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// forkApp
// ---------------------------------------------------------------------------

describe("forkApp", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
    mockPoolConnect = async () => ({
      query: async () => ({ rows: [] }),
      release: () => {},
    });
  });

  it("throws 404 when version not found", async () => {
    mockPoolQuery = async () => ({ rows: [] });

    await assert.rejects(
      () => forkApp({ version_id: "ver_missing", name: "test" }, "hobby", "https://api.run402.com"),
      (err: any) => {
        assert.ok(err instanceof ForkError);
        assert.equal(err.statusCode, 404);
        assert.ok(err.message.includes("not found"));
        return true;
      },
    );
  });

  it("throws 400 when version is not published", async () => {
    mockPoolQuery = async () => ({
      rows: [{
        id: "ver_001",
        project_id: "prj_src",
        name: "My App",
        visibility: "public",
        fork_allowed: true,
        status: "draft",
        min_tier: "prototype",
        derived_min_tier: "prototype",
        bundle_uri: "s3://bucket/bundle.json",
        bundle_sha256: "abc123",
        required_secrets: [],
        required_actions: [],
        site_deployment_id: null,
      }],
    });

    await assert.rejects(
      () => forkApp({ version_id: "ver_001", name: "test" }, "hobby", "https://api.run402.com"),
      (err: any) => {
        assert.ok(err instanceof ForkError);
        assert.equal(err.statusCode, 400);
        assert.ok(err.message.includes("not published"));
        return true;
      },
    );
  });

  it("throws 403 when fork_allowed is false", async () => {
    mockPoolQuery = async () => ({
      rows: [{
        id: "ver_001",
        project_id: "prj_src",
        name: "My App",
        visibility: "public",
        fork_allowed: false,
        status: "published",
        min_tier: "prototype",
        derived_min_tier: "prototype",
        bundle_uri: "s3://bucket/bundle.json",
        bundle_sha256: "abc123",
        required_secrets: [],
        required_actions: [],
        site_deployment_id: null,
      }],
    });

    await assert.rejects(
      () => forkApp({ version_id: "ver_001", name: "test" }, "hobby", "https://api.run402.com"),
      (err: any) => {
        assert.ok(err instanceof ForkError);
        assert.equal(err.statusCode, 403);
        assert.ok(err.message.includes("does not allow forking"));
        return true;
      },
    );
  });

  it("throws 403 when visibility is private", async () => {
    mockPoolQuery = async () => ({
      rows: [{
        id: "ver_001",
        project_id: "prj_src",
        name: "My App",
        visibility: "private",
        fork_allowed: true,
        status: "published",
        min_tier: "prototype",
        derived_min_tier: "prototype",
        bundle_uri: "s3://bucket/bundle.json",
        bundle_sha256: "abc123",
        required_secrets: [],
        required_actions: [],
        site_deployment_id: null,
      }],
    });

    await assert.rejects(
      () => forkApp({ version_id: "ver_001", name: "test" }, "hobby", "https://api.run402.com"),
      (err: any) => {
        assert.ok(err instanceof ForkError);
        assert.equal(err.statusCode, 403);
        assert.ok(err.message.includes("private"));
        return true;
      },
    );
  });

  it("throws 400 when tier is below minimum required", async () => {
    mockPoolQuery = async () => ({
      rows: [{
        id: "ver_001",
        project_id: "prj_src",
        name: "My App",
        visibility: "public",
        fork_allowed: true,
        status: "published",
        min_tier: "team",
        derived_min_tier: "hobby",
        bundle_uri: "s3://bucket/bundle.json",
        bundle_sha256: "abc123",
        required_secrets: [],
        required_actions: [],
        site_deployment_id: null,
      }],
    });

    await assert.rejects(
      () => forkApp({ version_id: "ver_001", name: "test" }, "prototype", "https://api.run402.com"),
      (err: any) => {
        assert.ok(err instanceof ForkError);
        assert.equal(err.statusCode, 400);
        assert.ok(err.message.includes("below minimum"));
        return true;
      },
    );
  });

  it("throws 400 when tier is below derived minimum tier", async () => {
    mockPoolQuery = async () => ({
      rows: [{
        id: "ver_001",
        project_id: "prj_src",
        name: "My App",
        visibility: "public",
        fork_allowed: true,
        status: "published",
        min_tier: "prototype",
        derived_min_tier: "team",
        bundle_uri: "s3://bucket/bundle.json",
        bundle_sha256: "abc123",
        required_secrets: [],
        required_actions: [],
        site_deployment_id: null,
      }],
    });

    await assert.rejects(
      () => forkApp({ version_id: "ver_001", name: "test" }, "hobby", "https://api.run402.com"),
      (err: any) => {
        assert.ok(err instanceof ForkError);
        assert.equal(err.statusCode, 400);
        assert.ok(err.message.includes("below minimum"));
        return true;
      },
    );
  });

  it("throws 503 when S3 is not configured", async () => {
    // S3_BUCKET is mocked as undefined, so after passing all validations it hits the S3 check
    mockPoolQuery = async () => ({
      rows: [{
        id: "ver_001",
        project_id: "prj_src",
        name: "My App",
        visibility: "public",
        fork_allowed: true,
        status: "published",
        min_tier: "prototype",
        derived_min_tier: "prototype",
        bundle_uri: "s3://undefined/bundles/ver_001.json",
        bundle_sha256: "abc123",
        required_secrets: [],
        required_actions: [],
        site_deployment_id: null,
      }],
    });

    await assert.rejects(
      () => forkApp({ version_id: "ver_001", name: "test" }, "hobby", "https://api.run402.com"),
      (err: any) => {
        assert.ok(err instanceof ForkError);
        assert.equal(err.statusCode, 503);
        assert.ok(err.message.includes("S3 not configured"));
        return true;
      },
    );
  });

  it("loads a local bundle when S3 is not configured", async () => {
    const storageRoot = join(process.cwd(), "storage");
    const versionId = "ver_local";
    const bundleKey = `app-versions/${versionId}/bundle.json`;
    const bundle = {
      pre_schema_sql: "",
      post_schema_sql: "",
      seed_sql: null,
    };
    const bundleJson = JSON.stringify(bundle);
    const bundleSha256 = createHash("sha256").update(bundleJson).digest("hex");

    try {
      mkdirSync(join(storageRoot, `app-versions/${versionId}`), { recursive: true });
      writeFileSync(join(storageRoot, bundleKey), bundleJson);

      let queryIndex = 0;
      mockPoolQuery = async () => {
        queryIndex++;
        if (queryIndex === 1) {
          return {
            rows: [{
              id: versionId,
              project_id: "prj_src",
              name: "Local App",
              visibility: "public",
              fork_allowed: true,
              status: "published",
              min_tier: "prototype",
              derived_min_tier: "prototype",
              bundle_uri: `local://${bundleKey}`,
              bundle_sha256: bundleSha256,
              required_secrets: [],
              required_actions: [],
              site_deployment_id: null,
            }],
          };
        }
        if (queryIndex === 2) return { rows: [] };
        if (queryIndex === 3) return { rows: [{ schema_slot: "p0042" }] };
        if (queryIndex === 4) return { rows: [] };
        if (queryIndex === 5) return { rows: [] };
        if (queryIndex === 6) return { rows: [] };
        if (queryIndex === 7) return { rows: [], rowCount: 1 };
        return { rows: [] };
      };

      const result = await forkApp({ version_id: versionId, name: "local-fork" }, "hobby", "https://api.run402.com");

      assert.equal(result.project_id, "prj_123");
      assert.equal(result.anon_key, "anon-key-abc");
      assert.equal(result.service_key, "service-key-xyz");
      assert.equal(result.schema_slot, "p0042");
      assert.equal(result.source_version_id, versionId);
      assert.equal(result.readiness, "ready");
    } finally {
      rmSync(join(storageRoot, `app-versions/${versionId}`), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// executeSqlViaPsql
// ---------------------------------------------------------------------------

describe("executeSqlViaPsql", () => {
  it("throws ForkError when psql is not available or fails", async () => {
    const oldPort = process.env.DB_PORT;
    process.env.DB_PORT = "1"; // force connection failure regardless of local Postgres availability
    try {
      await assert.rejects(
        () => executeSqlViaPsql("SELECT 1", "test label"),
        (err: any) => {
          assert.ok(err instanceof ForkError);
          assert.equal(err.statusCode, 500);
          assert.ok(err.message.includes("Fork test label failed"));
          return true;
        },
      );
    } finally {
      if (oldPort === undefined) delete process.env.DB_PORT;
      else process.env.DB_PORT = oldPort;
    }
  });
});
