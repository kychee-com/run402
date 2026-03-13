import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatApiError, projectNotFound } from "./errors.js";

describe("formatApiError", () => {
  it("includes context, error message, and status code", () => {
    const result = formatApiError(
      { status: 400, body: { error: "Bad request" } },
      "running SQL",
    );
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("running SQL"));
    assert.ok(result.content[0]!.text.includes("Bad request"));
    assert.ok(result.content[0]!.text.includes("400"));
  });

  it("includes hint when present", () => {
    const result = formatApiError(
      { status: 400, body: { error: "Blocked", hint: "Use X instead" } },
      "querying",
    );
    assert.ok(result.content[0]!.text.includes("Hint: Use X instead"));
  });

  it("includes retry_after for 429", () => {
    const result = formatApiError(
      { status: 429, body: { error: "Rate limited", retry_after: 30 } },
      "deploying",
    );
    assert.ok(result.content[0]!.text.includes("30 seconds"));
    assert.ok(result.content[0]!.text.includes("Rate limit hit"));
  });

  it("includes renew_url when present", () => {
    const result = formatApiError(
      { status: 403, body: { error: "Expired", renew_url: "/projects/v1/p1/renew" } },
      "running SQL",
    );
    assert.ok(result.content[0]!.text.includes("Renew URL: /projects/v1/p1/renew"));
    assert.ok(result.content[0]!.text.includes("lease may have expired"));
  });

  it("includes usage and expires_at when present", () => {
    const result = formatApiError(
      {
        status: 403,
        body: {
          error: "Over limit",
          expires_at: "2026-04-01T00:00:00Z",
          usage: { api_calls: 950, limit: 1000, storage_bytes: 500, storage_limit: 1024 },
        },
      },
      "fetching usage",
    );
    assert.ok(result.content[0]!.text.includes("Expires: 2026-04-01T00:00:00Z"));
    assert.ok(result.content[0]!.text.includes("API calls: 950/1000"));
    assert.ok(result.content[0]!.text.includes("Storage: 500/1024 bytes"));
  });

  it("uses message field (PostgREST style) as primary error", () => {
    const result = formatApiError(
      { status: 400, body: { message: "relation does not exist" } },
      "running SQL",
    );
    assert.ok(result.content[0]!.text.includes("relation does not exist"));
  });

  it("falls back to error field when message is absent", () => {
    const result = formatApiError(
      { status: 500, body: { error: "Internal failure" } },
      "deploying",
    );
    assert.ok(result.content[0]!.text.includes("Internal failure"));
  });

  it("handles string body gracefully", () => {
    const result = formatApiError(
      { status: 502, body: "Bad Gateway" },
      "deploying",
    );
    assert.ok(result.content[0]!.text.includes("Bad Gateway"));
    assert.ok(result.content[0]!.text.includes("502"));
  });

  it("falls back to Unknown error for empty body", () => {
    const result = formatApiError(
      { status: 500, body: {} },
      "deploying",
    );
    assert.ok(result.content[0]!.text.includes("Unknown error"));
    assert.ok(result.content[0]!.text.includes("500"));
  });

  it("adds correct guidance for each status code", () => {
    const cases: Array<[number, string]> = [
      [401, "Re-provision the project"],
      [403, "lease may have expired"],
      [404, "Check that the resource name"],
      [429, "Rate limit hit"],
      [500, "Server error"],
      [503, "Server error"],
    ];
    for (const [status, expected] of cases) {
      const result = formatApiError(
        { status, body: { error: "err" } },
        "testing",
      );
      assert.ok(
        result.content[0]!.text.includes(expected),
        `Status ${status} should include "${expected}", got: ${result.content[0]!.text}`,
      );
    }
  });

  it("always sets isError to true", () => {
    const result = formatApiError(
      { status: 400, body: { error: "x" } },
      "testing",
    );
    assert.equal(result.isError, true);
  });
});

describe("projectNotFound", () => {
  it("returns error with project ID and provision guidance", () => {
    const result = projectNotFound("proj-123");
    assert.ok(result.content[0]!.text.includes("proj-123"));
    assert.ok(result.content[0]!.text.includes("not found in key store"));
    assert.ok(result.content[0]!.text.includes("provision_postgres_project"));
  });

  it("always sets isError to true", () => {
    const result = projectNotFound("any-id");
    assert.equal(result.isError, true);
  });
});
