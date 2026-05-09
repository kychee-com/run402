import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatApiError,
  formatCanonicalErrorContext,
  projectNotFound,
} from "./errors.js";

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

  it("renders canonical scalar context and code-specific guidance", () => {
    const result = formatApiError(
      {
        status: 403,
        body: {
          error: "frozen",
          message: "Project is frozen.",
          code: "PROJECT_FROZEN",
          category: "lifecycle",
          retryable: false,
          safe_to_retry: true,
          mutation_state: "none",
          trace_id: "trc_abc",
        },
      },
      "deploying release",
    );
    const text = result.content[0]!.text;

    assert.ok(text.includes("Project is frozen."));
    assert.ok(text.includes("HTTP 403"));
    assert.ok(text.includes("Code: `PROJECT_FROZEN`"));
    assert.ok(text.includes("Category: lifecycle"));
    assert.ok(text.includes("Retryable: false"));
    assert.ok(text.includes("Safe to retry: true"));
    assert.ok(text.includes("Mutation state: none"));
    assert.ok(text.includes("Trace: trc_abc"));
    assert.ok(text.includes("get_usage"));
    assert.ok(text.includes("set_tier"));
    assert.ok(!text.includes("lease may have expired"));
  });

  it("renders canonical next actions without executing them", () => {
    const result = formatApiError(
      {
        status: 402,
        body: {
          message: "Payment required.",
          code: "PAYMENT_REQUIRED",
          category: "payment",
          next_actions: [
            { action: "submit_payment", label: "Submit the x402 payment" },
            { action: "renew_tier" },
            { action: "check_usage", description: "Inspect current limits" },
          ],
        },
      },
      "renewing project",
    );
    const text = result.content[0]!.text;

    assert.ok(text.includes("Next actions:"));
    assert.ok(text.includes("submit_payment: Submit the x402 payment"));
    assert.ok(text.includes("renew_tier"));
    assert.ok(text.includes("check_usage: Inspect current limits"));
  });

  it("formats canonical details when requested", () => {
    const lines = formatCanonicalErrorContext(
      {
        code: "MIGRATION_FAILED",
        details: { statement_offset: 184, migration_id: "001_init" },
      },
      { includeDetails: true },
    );
    const text = lines.join("\n");

    assert.ok(text.includes("Code: `MIGRATION_FAILED`"));
    assert.ok(text.includes("Details:"));
    assert.ok(text.includes('"statement_offset": 184'));
    assert.ok(text.includes('"migration_id": "001_init"'));
  });

  it("formats deploy retry metadata", () => {
    const lines = formatCanonicalErrorContext({
      code: "BASE_RELEASE_CONFLICT",
      attempts: 3,
      max_retries: 2,
      last_retry_code: "BASE_RELEASE_CONFLICT",
    });
    const text = lines.join("\n");

    assert.ok(text.includes("Attempts: 3"));
    assert.ok(text.includes("Max retries: 2"));
    assert.ok(text.includes("Last retry code: `BASE_RELEASE_CONFLICT`"));
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

  it("renders full lifecycle fields on a 402 with a reactivate hint", () => {
    const result = formatApiError(
      {
        status: 402,
        body: {
          message: "Project is past_due",
          lifecycle_state: "past_due",
          entered_state_at: "2026-04-01T00:00:00Z",
          next_transition_at: "2026-04-15T00:00:00Z",
          scheduled_purge_at: "2026-07-14T00:00:00Z",
          renew_url: "/tiers/v1/prototype",
        },
      },
      "deploying site",
    );
    const text = result.content[0]!.text;
    assert.ok(text.includes("state=past_due"));
    assert.ok(text.includes("entered=2026-04-01T00:00:00Z"));
    assert.ok(text.includes("next=2026-04-15T00:00:00Z"));
    assert.ok(text.includes("purge_at=2026-07-14T00:00:00Z"));
    assert.ok(text.includes("soft-delete grace window"));
    assert.ok(text.includes("set_tier"));
    assert.ok(text.includes("Renew URL: /tiers/v1/prototype"));
  });

  it("renders partial lifecycle fields without undefined/null placeholders", () => {
    const result = formatApiError(
      {
        status: 402,
        body: {
          message: "Project is frozen",
          lifecycle_state: "frozen",
          entered_state_at: "2026-04-14T00:00:00Z",
        },
      },
      "rotating secret",
    );
    const text = result.content[0]!.text;
    assert.ok(text.includes("state=frozen"));
    assert.ok(text.includes("entered=2026-04-14T00:00:00Z"));
    assert.ok(!text.includes("undefined"));
    assert.ok(!text.includes("null"));
    assert.ok(!text.includes("next="));
    assert.ok(!text.includes("purge_at="));
  });

  it("leaves non-lifecycle 402 guidance unchanged when lifecycle_state is absent", () => {
    const result = formatApiError(
      {
        status: 402,
        body: {
          message: "Payment required",
          usage: { api_calls: 1000, limit: 1000 },
          renew_url: "/tiers/v1/hobby",
        },
      },
      "running SQL",
    );
    const text = result.content[0]!.text;
    assert.ok(text.includes("API calls: 1000/1000"));
    assert.ok(text.includes("Renew URL: /tiers/v1/hobby"));
    assert.ok(!text.includes("Lifecycle:"));
    assert.ok(!text.includes("soft-delete grace window"));
  });

  it("adds distinct 409 reserved-name guidance, not 403 lease-expired text", () => {
    const result = formatApiError(
      {
        status: 409,
        body: {
          message: "Subdomain reserved",
          hint: "Name held for original owner during grace period",
        },
      },
      "claiming subdomain",
    );
    const text = result.content[0]!.text;
    assert.ok(text.includes("409"));
    assert.ok(text.includes("Hint: Name held for original owner"));
    assert.ok(text.includes("reserved"));
    assert.ok(!text.includes("lease may have expired"));
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
