import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mock DB pool and external dependencies before importing the module under test
// ---------------------------------------------------------------------------

let mockPoolQuery: (...args: any[]) => Promise<any>;
let mockGetDeployment: (id: string) => Promise<any>;
let mockProjectCacheGet: (id: string) => any;

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      query: (...args: any[]) => mockPoolQuery(...args),
    },
  },
});

mock.module("./deployments.js", {
  namedExports: {
    getDeployment: (id: string) => mockGetDeployment(id),
  },
});

mock.module("./kvs.js", {
  namedExports: {
    kvsPut: () => {},
    kvsDelete: () => {},
    cfInvalidate: () => {},
  },
});

let mockGetProjectById: (id: string) => Promise<any>;

mock.module("./projects.js", {
  namedExports: {
    projectCache: {
      get: (id: string) => mockProjectCacheGet(id),
    },
    getProjectById: (id: string) => mockGetProjectById(id),
  },
});

const {
  validateSubdomainName,
  createOrUpdateSubdomain,
  SubdomainError,
} = await import("./subdomains.js");

describe("validateSubdomainName", () => {
  // --- Valid names ---
  it("accepts 'myapp'", () => {
    assert.equal(validateSubdomainName("myapp"), null);
  });

  it("accepts 'my-app'", () => {
    assert.equal(validateSubdomainName("my-app"), null);
  });

  it("accepts 'a1b'", () => {
    assert.equal(validateSubdomainName("a1b"), null);
  });

  it("accepts 'abc' (min 3 chars)", () => {
    assert.equal(validateSubdomainName("abc"), null);
  });

  it("accepts 63-char name (max)", () => {
    const name = "a".repeat(63);
    assert.equal(validateSubdomainName(name), null);
  });

  it("accepts name containing reserved word but not exact match", () => {
    assert.equal(validateSubdomainName("api-dashboard"), null);
  });

  // --- Invalid: too short ---
  it("rejects 2-char name", () => {
    const err = validateSubdomainName("ab");
    assert.ok(err);
    assert.ok(err.includes("3-63"));
  });

  // --- Invalid: too long ---
  it("rejects 64-char name", () => {
    const name = "a".repeat(64);
    const err = validateSubdomainName(name);
    assert.ok(err);
    assert.ok(err.includes("3-63"));
  });

  // --- Invalid: uppercase ---
  it("rejects uppercase", () => {
    const err = validateSubdomainName("MyApp");
    assert.ok(err);
    assert.ok(err.includes("lowercase"));
  });

  // --- Invalid: leading hyphen ---
  it("rejects leading hyphen", () => {
    const err = validateSubdomainName("-bad");
    assert.ok(err);
  });

  // --- Invalid: trailing hyphen ---
  it("rejects trailing hyphen", () => {
    const err = validateSubdomainName("bad-");
    assert.ok(err);
  });

  // --- Invalid: consecutive hyphens ---
  it("rejects consecutive hyphens", () => {
    const err = validateSubdomainName("my--app");
    assert.ok(err);
    assert.ok(err.includes("consecutive"));
  });

  // --- Invalid: special chars ---
  it("rejects underscore", () => {
    const err = validateSubdomainName("my_app");
    assert.ok(err);
  });

  it("rejects dot", () => {
    const err = validateSubdomainName("my.app");
    assert.ok(err);
  });

  // --- Reserved names ---
  it("rejects 'api' as reserved", () => {
    const err = validateSubdomainName("api");
    assert.ok(err);
    assert.ok(err.includes("reserved"));
  });

  it("rejects 'www' as reserved", () => {
    const err = validateSubdomainName("www");
    assert.ok(err);
    assert.ok(err.includes("reserved"));
  });

  it("rejects 'admin' as reserved", () => {
    const err = validateSubdomainName("admin");
    assert.ok(err);
    assert.ok(err.includes("reserved"));
  });

  it("rejects 'sites' as reserved", () => {
    const err = validateSubdomainName("sites");
    assert.ok(err);
    assert.ok(err.includes("reserved"));
  });
});

// ---------------------------------------------------------------------------
// createOrUpdateSubdomain — ownership and wallet-based reassignment
// ---------------------------------------------------------------------------

/** Helper: mock an existing subdomain row belonging to a project */
function setupExistingSubdomain(projectId: string) {
  return {
    name: "myapp",
    deployment_id: "dpl_old",
    project_id: projectId,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

/** Standard upsert result returned by pool.query for the INSERT...ON CONFLICT */
function upsertResult(name: string, deploymentId: string, projectId: string) {
  return {
    rows: [{
      name,
      deployment_id: deploymentId,
      project_id: projectId,
      created_at: "2026-03-11T00:00:00Z",
      updated_at: "2026-03-11T00:00:00Z",
    }],
  };
}

describe("createOrUpdateSubdomain — ownership", () => {
  beforeEach(() => {
    // Default: deployment exists
    mockGetDeployment = async () => ({ id: "dpl_new" });
    // Default: no cached project
    mockProjectCacheGet = () => undefined;
    // Default: project lookup returns null (not found)
    mockGetProjectById = async () => null;
  });

  it("succeeds when subdomain is new (no existing record)", async () => {
    // getSubdomain returns null (pool.query for SELECT returns empty)
    // then upsert succeeds
    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) return { rows: [] }; // getSubdomain → not found
      return upsertResult("myapp", "dpl_new", "prj_new"); // upsert
    };

    const result = await createOrUpdateSubdomain("myapp", "dpl_new", "prj_new");
    assert.equal(result.name, "myapp");
    assert.equal(result.deployment_id, "dpl_new");
  });

  it("succeeds when same project reassigns subdomain", async () => {
    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) {
        // getSubdomain → existing record with same project
        return { rows: [setupExistingSubdomain("prj_same")] };
      }
      return upsertResult("myapp", "dpl_new", "prj_same");
    };

    const result = await createOrUpdateSubdomain("myapp", "dpl_new", "prj_same");
    assert.equal(result.deployment_id, "dpl_new");
  });

  it("throws 403 when different project with no wallet", async () => {
    mockPoolQuery = async () => ({
      rows: [setupExistingSubdomain("prj_old")],
    });

    await assert.rejects(
      () => createOrUpdateSubdomain("myapp", "dpl_new", "prj_new"),
      (err: any) => {
        assert.ok(err instanceof SubdomainError);
        assert.equal(err.statusCode, 403);
        assert.ok(err.message.includes("already claimed by another wallet"));
        return true;
      },
    );
  });

  it("throws 403 when different project with different wallet", async () => {
    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) return { rows: [setupExistingSubdomain("prj_old")] };
      // DB fallback for wallet lookup
      return { rows: [{ wallet_address: "0xOLDWALLET" }] };
    };
    mockProjectCacheGet = () => undefined; // not in cache

    await assert.rejects(
      () => createOrUpdateSubdomain("myapp", "dpl_new", "prj_new", "0xNEWWALLET"),
      (err: any) => {
        assert.ok(err instanceof SubdomainError);
        assert.equal(err.statusCode, 403);
        return true;
      },
    );
  });

  it("allows reassignment when same wallet (via project cache)", async () => {
    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) return { rows: [setupExistingSubdomain("prj_old")] };
      return upsertResult("myapp", "dpl_new", "prj_new"); // upsert
    };
    mockProjectCacheGet = (id: string) => {
      if (id === "prj_old") return { walletAddress: "0xABCDEF" };
      return undefined;
    };

    const result = await createOrUpdateSubdomain("myapp", "dpl_new", "prj_new", "0xabcdef");
    assert.equal(result.deployment_id, "dpl_new");
    assert.equal(result.project_id, "prj_new");
  });

  it("allows reassignment when same wallet (case-insensitive, via DB fallback)", async () => {
    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) return { rows: [setupExistingSubdomain("prj_old")] };
      if (queryCount === 2) return { rows: [{ wallet_address: "0xDeAdBeEf" }] }; // DB wallet lookup
      return upsertResult("myapp", "dpl_new", "prj_new"); // upsert
    };
    mockProjectCacheGet = () => undefined; // not in cache, forces DB fallback

    const result = await createOrUpdateSubdomain("myapp", "dpl_new", "prj_new", "0xDEADBEEF");
    assert.equal(result.deployment_id, "dpl_new");
  });

  it("throws 403 when wallet provided but old project has no wallet", async () => {
    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) return { rows: [setupExistingSubdomain("prj_old")] };
      // DB fallback returns null wallet
      return { rows: [{ wallet_address: null }] };
    };
    mockProjectCacheGet = () => undefined;

    await assert.rejects(
      () => createOrUpdateSubdomain("myapp", "dpl_new", "prj_new", "0xNEWWALLET"),
      (err: any) => {
        assert.equal(err.statusCode, 403);
        return true;
      },
    );
  });

  it("throws 404 when deployment does not exist", async () => {
    mockGetDeployment = async () => null;

    await assert.rejects(
      () => createOrUpdateSubdomain("myapp", "dpl_gone", "prj_new"),
      (err: any) => {
        assert.ok(err instanceof SubdomainError);
        assert.equal(err.statusCode, 404);
        assert.ok(err.message.includes("not found"));
        return true;
      },
    );
  });

  it("deployment-not-found error message tells user to deploy first", async () => {
    mockGetDeployment = async () => null;

    await assert.rejects(
      () => createOrUpdateSubdomain("myapp", "prj_123_1", "prj_123_1"),
      (err: any) => {
        assert.ok(err instanceof SubdomainError);
        assert.ok(
          err.message.toLowerCase().includes("deploy") && err.message.toLowerCase().includes("first"),
          `Error message should guide user to deploy first, got: "${err.message}"`,
        );
        return true;
      },
    );
  });
});
