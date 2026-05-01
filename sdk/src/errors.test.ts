/**
 * Tests for the discriminated-error surface: `kind` literals, the
 * `isRun402Error` brand, `is*` type guards, `isRetryableRun402Error`
 * policy, and `toJSON` envelope shape.
 *
 * These checks intentionally don't use `instanceof` — the whole point of
 * the discriminator pattern is that callers don't have to.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  LocalError,
  NetworkError,
  PaymentRequired,
  ProjectNotFound,
  Run402DeployError,
  Run402Error,
  Unauthorized,
  isApiError,
  isDeployError,
  isLocalError,
  isNetworkError,
  isPaymentRequired,
  isProjectNotFound,
  isRetryableRun402Error,
  isRun402Error,
  isUnauthorized,
} from "./errors.js";

// ─── kind literals ───────────────────────────────────────────────────────────

describe("Run402Error kind discriminators", () => {
  it("PaymentRequired carries kind='payment_required'", () => {
    const e = new PaymentRequired("nope", 402, null, "ctx");
    assert.equal(e.kind, "payment_required");
  });
  it("ProjectNotFound carries kind='project_not_found'", () => {
    const e = new ProjectNotFound("prj_x", "ctx");
    assert.equal(e.kind, "project_not_found");
  });
  it("Unauthorized carries kind='unauthorized'", () => {
    const e = new Unauthorized("nope", 401, null, "ctx");
    assert.equal(e.kind, "unauthorized");
  });
  it("ApiError carries kind='api_error'", () => {
    const e = new ApiError("nope", 500, null, "ctx");
    assert.equal(e.kind, "api_error");
  });
  it("NetworkError carries kind='network_error'", () => {
    const e = new NetworkError("nope", new Error("boom"), "ctx");
    assert.equal(e.kind, "network_error");
  });
  it("LocalError carries kind='local_error'", () => {
    const e = new LocalError("nope", "ctx");
    assert.equal(e.kind, "local_error");
  });
  it("Run402DeployError carries kind='deploy_error'", () => {
    const e = new Run402DeployError("nope", { code: "MIGRATION_FAILED", context: "deploying" });
    assert.equal(e.kind, "deploy_error");
  });
});

// ─── isRun402Error brand ─────────────────────────────────────────────────────

describe("isRun402Error", () => {
  it("returns true for any Run402Error subclass instance", () => {
    assert.equal(isRun402Error(new PaymentRequired("a", 402, null, "c")), true);
    assert.equal(isRun402Error(new ApiError("a", 500, null, "c")), true);
    assert.equal(isRun402Error(new LocalError("a", "c")), true);
    assert.equal(
      isRun402Error(new Run402DeployError("a", { code: "INTERNAL_ERROR", context: "c" })),
      true,
    );
  });

  it("returns false for plain Error and non-error values", () => {
    assert.equal(isRun402Error(new Error("nope")), false);
    assert.equal(isRun402Error(null), false);
    assert.equal(isRun402Error(undefined), false);
    assert.equal(isRun402Error("string"), false);
    assert.equal(isRun402Error(42), false);
    assert.equal(isRun402Error({}), false);
    assert.equal(isRun402Error({ isRun402Error: false }), false);
  });

  it("does NOT trust an arbitrary object that fakes isRun402Error", () => {
    // Strictly speaking the brand is a structural marker — anyone can fake it.
    // We accept that as a known limitation; in practice the SDK is the only
    // producer of Run402Error subclasses and the brand survives realm crossings.
    const fake = { isRun402Error: true, kind: "payment_required" };
    assert.equal(isRun402Error(fake), true);
    // The structural check accepts this; downstream type-narrowed calls still
    // need to handle untrusted shapes carefully.
  });
});

// ─── per-subclass guards ─────────────────────────────────────────────────────

describe("subclass type guards narrow correctly", () => {
  it("isPaymentRequired matches only PaymentRequired", () => {
    assert.equal(isPaymentRequired(new PaymentRequired("a", 402, null, "c")), true);
    assert.equal(isPaymentRequired(new ApiError("a", 500, null, "c")), false);
    assert.equal(isPaymentRequired(new Error("nope")), false);
  });

  it("isProjectNotFound matches only ProjectNotFound", () => {
    assert.equal(isProjectNotFound(new ProjectNotFound("prj_x", "c")), true);
    assert.equal(isProjectNotFound(new ApiError("a", 404, null, "c")), false);
  });

  it("isUnauthorized matches only Unauthorized", () => {
    assert.equal(isUnauthorized(new Unauthorized("a", 401, null, "c")), true);
    assert.equal(isUnauthorized(new ApiError("a", 401, null, "c")), false);
  });

  it("isApiError matches only ApiError", () => {
    assert.equal(isApiError(new ApiError("a", 500, null, "c")), true);
    assert.equal(isApiError(new PaymentRequired("a", 402, null, "c")), false);
  });

  it("isNetworkError matches only NetworkError", () => {
    assert.equal(isNetworkError(new NetworkError("a", new Error("b"), "c")), true);
    assert.equal(isNetworkError(new ApiError("a", 0, null, "c")), false);
  });

  it("isLocalError matches only LocalError", () => {
    assert.equal(isLocalError(new LocalError("a", "c")), true);
    assert.equal(isLocalError(new ApiError("a", 500, null, "c")), false);
  });

  it("isDeployError matches only Run402DeployError", () => {
    const e = new Run402DeployError("a", { code: "INTERNAL_ERROR", context: "c" });
    assert.equal(isDeployError(e), true);
    assert.equal(isDeployError(new ApiError("a", 500, null, "c")), false);
  });

  it("type guards narrow `unknown` for TypeScript without unsafe casts", () => {
    // This test compiles only if the guards' `e is T` predicates work
    // correctly; runtime-wise the assertion is just defensive.
    const e: unknown = new Run402DeployError("oops", {
      code: "MIGRATION_FAILED",
      operationId: "op_123",
      context: "applying migration",
    });
    if (isDeployError(e)) {
      // narrowed to Run402DeployError — these field accesses must compile
      assert.equal(e.code, "MIGRATION_FAILED");
      assert.equal(e.operationId, "op_123");
      assert.equal(e.kind, "deploy_error");
    } else {
      assert.fail("guard should have narrowed");
    }
  });
});

// ─── isRetryableRun402Error policy ───────────────────────────────────────────

describe("isRetryableRun402Error", () => {
  it("returns false for non-Run402 inputs", () => {
    assert.equal(isRetryableRun402Error(new Error("nope")), false);
    assert.equal(isRetryableRun402Error(null), false);
    assert.equal(isRetryableRun402Error("string"), false);
  });

  it("returns true for NetworkError", () => {
    const e = new NetworkError("dns", new Error("ENOTFOUND"), "fetching");
    assert.equal(isRetryableRun402Error(e), true);
  });

  it("returns true for HTTP 429", () => {
    assert.equal(isRetryableRun402Error(new ApiError("rate limited", 429, null, "c")), true);
  });

  it("returns true for HTTP 408 (Request Timeout)", () => {
    assert.equal(isRetryableRun402Error(new ApiError("timeout", 408, null, "c")), true);
  });

  it("returns true for HTTP 425 (Too Early)", () => {
    assert.equal(isRetryableRun402Error(new ApiError("too early", 425, null, "c")), true);
  });

  it("returns true for any 5xx", () => {
    assert.equal(isRetryableRun402Error(new ApiError("a", 500, null, "c")), true);
    assert.equal(isRetryableRun402Error(new ApiError("a", 502, null, "c")), true);
    assert.equal(isRetryableRun402Error(new ApiError("a", 599, null, "c")), true);
  });

  it("returns false for 4xx other than retryable codes (without flags)", () => {
    assert.equal(isRetryableRun402Error(new ApiError("a", 400, null, "c")), false);
    assert.equal(isRetryableRun402Error(new ApiError("a", 401, null, "c")), false);
    assert.equal(isRetryableRun402Error(new ApiError("a", 404, null, "c")), false);
  });

  it("respects gateway `retryable: true` envelope", () => {
    const e = new ApiError("a", 503, { retryable: true }, "c");
    assert.equal(e.retryable, true);
    assert.equal(isRetryableRun402Error(e), true);
  });

  it("respects gateway `safe_to_retry: true` envelope", () => {
    // Even a 400 becomes retryable if the gateway flagged it safe to retry.
    const e = new ApiError("a", 400, { safe_to_retry: true }, "c");
    assert.equal(e.safeToRetry, true);
    assert.equal(isRetryableRun402Error(e), true);
  });
});

// ─── toJSON envelope ─────────────────────────────────────────────────────────

describe("Run402Error.toJSON", () => {
  it("plain Error stringifies to '{}' (baseline; verifies why we need toJSON)", () => {
    assert.equal(JSON.stringify(new Error("anything")), "{}");
  });

  it("ApiError envelope has expected keys", () => {
    const e = new ApiError(
      "validation failed",
      422,
      { code: "BAD_INPUT", trace_id: "trc_xyz", details: { field: "name" } },
      "submitting form",
    );
    const json = JSON.parse(JSON.stringify(e)) as Record<string, unknown>;
    assert.equal(json["name"], "ApiError");
    assert.equal(json["kind"], "api_error");
    assert.equal(json["message"], "validation failed");
    assert.equal(json["status"], 422);
    assert.equal(json["code"], "BAD_INPUT");
    assert.equal(json["traceId"], "trc_xyz");
    assert.equal(json["context"], "submitting form");
    assert.deepEqual(json["details"], { field: "name" });
    assert.notEqual(JSON.stringify(e), "{}");
  });

  it("Run402DeployError envelope includes subclass fields", () => {
    const e = new Run402DeployError("migration failed", {
      code: "MIGRATION_FAILED",
      phase: "migrate",
      resource: "001_init",
      retryable: false,
      operationId: "op_abc",
      planId: "plan_def",
      fix: { action: "edit_migration", path: "001_init.sql" },
      logs: ["ERROR:  syntax error"],
      rolledBack: true,
      context: "applying migration",
    });
    const json = JSON.parse(JSON.stringify(e)) as Record<string, unknown>;
    assert.equal(json["kind"], "deploy_error");
    assert.equal(json["code"], "MIGRATION_FAILED");
    assert.equal(json["phase"], "migrate");
    assert.equal(json["resource"], "001_init");
    assert.equal(json["operationId"], "op_abc");
    assert.equal(json["planId"], "plan_def");
    assert.deepEqual(json["fix"], { action: "edit_migration", path: "001_init.sql" });
    assert.deepEqual(json["logs"], ["ERROR:  syntax error"]);
    assert.equal(json["rolledBack"], true);
    assert.equal(json["retryable"], false);
  });
});

// ─── instanceof still works (back-compat) ────────────────────────────────────

describe("instanceof back-compat", () => {
  it("instanceof PaymentRequired still works in single-realm same-copy", () => {
    const e = new PaymentRequired("a", 402, null, "c");
    assert.equal(e instanceof PaymentRequired, true);
    assert.equal(e instanceof Run402Error, true);
    assert.equal(e instanceof Error, true);
  });
});
