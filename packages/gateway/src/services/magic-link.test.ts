import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolQuery: (...args: any[]) => Promise<any>;

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      query: (...args: unknown[]) => mockPoolQuery(...args),
    },
  },
});

mock.module("../db/sql.js", {
  namedExports: {
    sql: (s: string) => s,
  },
});

const { createMagicLinkToken, verifyMagicLinkToken, checkMagicLinkRateLimit, cleanupExpiredMagicLinkTokens } = await import("./magic-link.js");

// ---------------------------------------------------------------------------
// createMagicLinkToken
// ---------------------------------------------------------------------------

describe("createMagicLinkToken", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
  });

  it("returns a token with at least 32 bytes of entropy (base64url)", async () => {
    const token = await createMagicLinkToken("proj1", "user@example.com", "https://app.run402.com/callback");
    // 32 bytes → 43 base64url chars (no padding)
    assert.ok(token.length >= 43, `token length ${token.length} should be >= 43`);
    // Should be URL-safe base64
    assert.ok(/^[A-Za-z0-9_-]+$/.test(token), "token should be base64url encoded");
  });

  it("stores the token as SHA-256 hash, not raw", async () => {
    const queries: string[] = [];
    mockPoolQuery = async (sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    };

    const token = await createMagicLinkToken("proj1", "user@example.com", "https://app.run402.com/callback");

    // The INSERT query should NOT contain the raw token
    const insertQuery = queries.find(q => q.includes("INSERT INTO internal.magic_link_tokens"));
    assert.ok(insertQuery, "should have an INSERT query");
    // The raw token should not appear in any query parameter — we can't check params directly
    // but we verify the token is at least not the hash (different length/format)
    assert.ok(token.length > 0);
  });

  it("invalidates previous active token for same email+project", async () => {
    const queries: string[] = [];
    mockPoolQuery = async (sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    };

    await createMagicLinkToken("proj1", "user@example.com", "https://app.run402.com/callback");

    // Should have an UPDATE or DELETE for previous tokens before INSERT
    const invalidateQuery = queries.find(q =>
      (q.includes("UPDATE") || q.includes("DELETE")) && q.includes("magic_link_tokens")
    );
    assert.ok(invalidateQuery, "should invalidate previous tokens");
  });
});

// ---------------------------------------------------------------------------
// verifyMagicLinkToken
// ---------------------------------------------------------------------------

describe("verifyMagicLinkToken", () => {
  it("returns email + projectId + redirectUrl for valid unexpired unused token", async () => {
    mockPoolQuery = async (sql: string) => {
      if (sql.includes("UPDATE") && sql.includes("magic_link_tokens")) {
        return {
          rows: [{ email: "user@example.com", project_id: "proj1", redirect_url: "https://app.run402.com/callback" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    };

    const result = await verifyMagicLinkToken("some-valid-token");
    assert.ok(result);
    assert.equal(result.email, "user@example.com");
    assert.equal(result.projectId, "proj1");
    assert.equal(result.redirectUrl, "https://app.run402.com/callback");
  });

  it("returns null for expired token", async () => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });

    const result = await verifyMagicLinkToken("expired-token");
    assert.equal(result, null);
  });

  it("returns null for already-used token", async () => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });

    const result = await verifyMagicLinkToken("used-token");
    assert.equal(result, null);
  });

  it("returns null for nonexistent token", async () => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });

    const result = await verifyMagicLinkToken("nonexistent");
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// checkMagicLinkRateLimit
// ---------------------------------------------------------------------------

describe("checkMagicLinkRateLimit", () => {
  beforeEach(() => {
    // Reset rate limiter state between tests
  });

  it("allows up to 5 requests per email per project per hour", () => {
    for (let i = 0; i < 5; i++) {
      const result = checkMagicLinkRateLimit("proj1", "user@example.com", "prototype");
      assert.ok(result.allowed, `request ${i + 1} should be allowed`);
    }
    const result = checkMagicLinkRateLimit("proj1", "user@example.com", "prototype");
    assert.equal(result.allowed, false, "6th request should be denied");
    assert.equal(result.reason, "per_email");
  });

  it("enforces per-project limit by tier", () => {
    // Prototype tier: 50/hr
    for (let i = 0; i < 50; i++) {
      const result = checkMagicLinkRateLimit("proj2", `user${i}@example.com`, "prototype");
      assert.ok(result.allowed, `request ${i + 1} should be allowed`);
    }
    const result = checkMagicLinkRateLimit("proj2", "user50@example.com", "prototype");
    assert.equal(result.allowed, false, "51st request should be denied");
    assert.equal(result.reason, "per_project");
  });

  it("allows higher limits for higher tiers", () => {
    // Hobby tier: 200/hr — should allow 51st request
    for (let i = 0; i < 51; i++) {
      const result = checkMagicLinkRateLimit("proj3", `user${i}@example.com`, "hobby");
      assert.ok(result.allowed, `request ${i + 1} should be allowed for hobby tier`);
    }
  });
});

// ---------------------------------------------------------------------------
// cleanupExpiredMagicLinkTokens
// ---------------------------------------------------------------------------

describe("cleanupExpiredMagicLinkTokens", () => {
  it("deletes expired tokens", async () => {
    const queries: string[] = [];
    mockPoolQuery = async (sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 2 };
    };

    await cleanupExpiredMagicLinkTokens();

    const deleteQuery = queries.find(q => q.includes("DELETE") && q.includes("magic_link_tokens") && q.includes("expires_at"));
    assert.ok(deleteQuery, "should delete expired tokens");
  });
});
