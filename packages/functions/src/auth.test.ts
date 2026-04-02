import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// Mock config
mock.module("./config.js", {
  namedExports: {
    config: {
      API_BASE: "https://test.run402.com",
      PROJECT_ID: "prj_test",
      SERVICE_KEY: "sk_test",
      JWT_SECRET: "test-jwt-secret-32chars-minimum!!",
    },
  },
});

const { getUser } = await import("./auth.js");

// Use jsonwebtoken to create test tokens
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const jwt = _require("jsonwebtoken") as typeof import("jsonwebtoken");

const SECRET = "test-jwt-secret-32chars-minimum!!";

function makeToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, SECRET);
}

function makeRequest(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader) headers.set("authorization", authHeader);
  return new Request("https://example.com", { headers });
}

describe("getUser", () => {
  it("returns user for valid token", () => {
    const token = makeToken({
      sub: "user-123",
      role: "authenticated",
      email: "user@example.com",
      project_id: "prj_test",
    });
    const user = getUser(makeRequest(`Bearer ${token}`));
    assert.deepEqual(user, {
      id: "user-123",
      role: "authenticated",
      email: "user@example.com",
    });
  });

  it("returns null for missing authorization header", () => {
    const user = getUser(makeRequest());
    assert.equal(user, null);
  });

  it("returns null for non-Bearer authorization", () => {
    const user = getUser(makeRequest("Basic abc123"));
    assert.equal(user, null);
  });

  it("returns null for invalid token", () => {
    const user = getUser(makeRequest("Bearer invalid.token.here"));
    assert.equal(user, null);
  });

  it("returns null for token signed with wrong secret", () => {
    const token = jwt.sign(
      { sub: "user-123", role: "authenticated", email: "u@e.com", project_id: "prj_test" },
      "wrong-secret-key-that-is-different",
    );
    const user = getUser(makeRequest(`Bearer ${token}`));
    assert.equal(user, null);
  });

  it("returns null for token from wrong project", () => {
    const token = makeToken({
      sub: "user-123",
      role: "authenticated",
      email: "u@e.com",
      project_id: "prj_OTHER",
    });
    const user = getUser(makeRequest(`Bearer ${token}`));
    assert.equal(user, null);
  });

  it("returns null for expired token", () => {
    const token = jwt.sign(
      { sub: "user-123", role: "authenticated", email: "u@e.com", project_id: "prj_test" },
      SECRET,
      { expiresIn: -10 },
    );
    const user = getUser(makeRequest(`Bearer ${token}`));
    assert.equal(user, null);
  });
});
