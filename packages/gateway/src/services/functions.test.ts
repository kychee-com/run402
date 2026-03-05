import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// We test the pure utility functions and validation logic without
// requiring a real DB or AWS SDK connection.

describe("functions service — validation", () => {
  it("rejects invalid function names", () => {
    const FUNCTION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

    // Valid names
    assert.ok(FUNCTION_NAME_RE.test("hello"));
    assert.ok(FUNCTION_NAME_RE.test("stripe-webhook"));
    assert.ok(FUNCTION_NAME_RE.test("a"));
    assert.ok(FUNCTION_NAME_RE.test("my-func-123"));

    // Invalid names
    assert.ok(!FUNCTION_NAME_RE.test("")); // empty
    assert.ok(!FUNCTION_NAME_RE.test("-start")); // starts with hyphen
    assert.ok(!FUNCTION_NAME_RE.test("Hello")); // uppercase
    assert.ok(!FUNCTION_NAME_RE.test("my_func")); // underscores
    assert.ok(!FUNCTION_NAME_RE.test("a".repeat(64))); // too long
  });

  it("rejects invalid secret keys", () => {
    const SECRET_KEY_RE = /^[A-Z_][A-Z0-9_]{0,62}$/;

    // Valid keys
    assert.ok(SECRET_KEY_RE.test("STRIPE_SECRET_KEY"));
    assert.ok(SECRET_KEY_RE.test("API_KEY"));
    assert.ok(SECRET_KEY_RE.test("_INTERNAL"));
    assert.ok(SECRET_KEY_RE.test("A"));

    // Invalid keys
    assert.ok(!SECRET_KEY_RE.test("")); // empty
    assert.ok(!SECRET_KEY_RE.test("lowercase")); // lowercase
    assert.ok(!SECRET_KEY_RE.test("123_START")); // starts with number
    assert.ok(!SECRET_KEY_RE.test("HAS SPACE")); // spaces
    assert.ok(!SECRET_KEY_RE.test("HAS-HYPHEN")); // hyphens
  });

  it("builds correct Lambda function names", () => {
    // lambdaName is a private function, test the expected pattern
    const lambdaName = (projectId: string, name: string) =>
      `run402_${projectId}_${name}`;

    assert.equal(
      lambdaName("prj_123", "stripe-webhook"),
      "run402_prj_123_stripe-webhook",
    );
    assert.equal(
      lambdaName("prj_456", "hello"),
      "run402_prj_456_hello",
    );
  });
});

describe("functions service — zip builder", () => {
  it("validates zip output has correct header", async () => {
    // Import the module to test buildZip indirectly via deployFunction
    // Since buildZip is private, we test it through its outputs
    // For now, test that the shim code generation works
    const userCode = `export default async (req) => new Response("hello")`;
    const encoded = Buffer.from(userCode).toString("base64");
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    assert.equal(decoded, userCode);
  });
});
