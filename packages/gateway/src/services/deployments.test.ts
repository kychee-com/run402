import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mock dependencies before importing the module under test
// ---------------------------------------------------------------------------

let mockPoolQuery: (...args: any[]) => Promise<any>;
let mockCacheInvalidateByNames: (names: string[]) => void;
let mockS3Send: (...args: any[]) => Promise<any>;

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
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
    S3Client: class { send = (...args: any[]) => mockS3Send(...args); },
    PutObjectCommand: class { constructor(public input: any) {} },
  },
});

mock.module("./subdomains.js", {
  namedExports: {
    cacheInvalidateByNames: (names: string[]) => mockCacheInvalidateByNames(names),
  },
});

const { createDeployment } = await import("./deployments.js");

// ---------------------------------------------------------------------------
// Auto-reassignment tests
// ---------------------------------------------------------------------------

describe("createDeployment — auto subdomain reassignment", () => {
  beforeEach(() => {
    mockS3Send = async () => ({});
    mockCacheInvalidateByNames = () => {};
  });

  it("reassigns subdomain when project has one", async () => {
    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) return { rows: [] }; // INSERT deployment
      // UPDATE subdomains RETURNING
      return { rows: [{ name: "myapp" }] };
    };

    const result = await createDeployment({
      project: "prj_123",
      files: [{ file: "index.html", data: "<h1>Hi</h1>" }],
    });

    assert.ok(result.deployment_id.startsWith("dpl_"));
    assert.deepEqual(result.subdomain_urls, ["https://myapp.run402.com"]);
  });

  it("does not include subdomain_urls when project has no subdomains", async () => {
    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) return { rows: [] }; // INSERT deployment
      return { rows: [] }; // UPDATE subdomains — no rows
    };

    const result = await createDeployment({
      project: "prj_456",
      files: [{ file: "index.html", data: "<h1>Hi</h1>" }],
    });

    assert.equal(result.subdomain_urls, undefined);
  });

  it("reassigns multiple subdomains", async () => {
    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) return { rows: [] }; // INSERT deployment
      return { rows: [{ name: "app1" }, { name: "app2" }] };
    };

    const result = await createDeployment({
      project: "prj_789",
      files: [{ file: "index.html", data: "<h1>Hi</h1>" }],
    });

    assert.deepEqual(result.subdomain_urls, [
      "https://app1.run402.com",
      "https://app2.run402.com",
    ]);
  });

  it("invalidates cache for reassigned subdomains", async () => {
    const invalidated: string[][] = [];
    mockCacheInvalidateByNames = (names) => invalidated.push(names);

    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) return { rows: [] };
      return { rows: [{ name: "cached-app" }] };
    };

    await createDeployment({
      project: "prj_cache",
      files: [{ file: "index.html", data: "<h1>Hi</h1>" }],
    });

    assert.equal(invalidated.length, 1);
    assert.deepEqual(invalidated[0], ["cached-app"]);
  });
});
