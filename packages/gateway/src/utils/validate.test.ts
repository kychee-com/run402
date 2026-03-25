import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateUUID, validateWalletAddress, validateEmail, validatePaginationInt, validateURL } from "./validate.js";
import { HttpError } from "./async-handler.js";

function expectHttpError(fn: () => unknown, status: number, msgPart?: string) {
  try {
    fn();
    assert.fail("Expected HttpError");
  } catch (err) {
    assert.ok(err instanceof HttpError, `Expected HttpError, got ${err}`);
    assert.equal(err.statusCode, status);
    if (msgPart) assert.ok(err.message.includes(msgPart), `Expected message to contain "${msgPart}", got "${err.message}"`);
  }
}

describe("validateUUID", () => {
  it("accepts a valid lowercase UUID", () => {
    assert.equal(validateUUID("550e8400-e29b-41d4-a716-446655440000", "id"), "550e8400-e29b-41d4-a716-446655440000");
  });

  it("accepts a valid uppercase UUID", () => {
    assert.equal(validateUUID("550E8400-E29B-41D4-A716-446655440000", "id"), "550E8400-E29B-41D4-A716-446655440000");
  });

  it("rejects non-UUID strings", () => {
    expectHttpError(() => validateUUID("also_invalid", "refresh_token"), 400, "refresh_token");
    expectHttpError(() => validateUUID("not-a-uuid", "id"), 400, "UUID");
  });

  it("rejects empty string", () => {
    expectHttpError(() => validateUUID("", "id"), 400);
  });

  it("rejects non-string values", () => {
    expectHttpError(() => validateUUID(123, "id"), 400);
    expectHttpError(() => validateUUID(null, "id"), 400);
    expectHttpError(() => validateUUID(undefined, "id"), 400);
  });
});

describe("validateWalletAddress", () => {
  it("accepts a valid 42-char address and lowercases it", () => {
    assert.equal(
      validateWalletAddress("0x059D091D51a0f011c9872EaA63Df538F5cE15945", "wallet"),
      "0x059d091d51a0f011c9872eaa63df538f5ce15945",
    );
  });

  it("rejects short address", () => {
    expectHttpError(() => validateWalletAddress("0x1234", "wallet"), 400, "42-character");
  });

  it("rejects non-hex characters", () => {
    expectHttpError(() => validateWalletAddress("0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", "wallet"), 400);
  });

  it("rejects missing 0x prefix", () => {
    expectHttpError(() => validateWalletAddress("059D091D51a0f011c9872EaA63Df538F5cE15945", "wallet"), 400);
  });

  it("rejects non-string", () => {
    expectHttpError(() => validateWalletAddress(42, "wallet"), 400);
  });
});

describe("validateEmail", () => {
  it("accepts and normalizes a valid email", () => {
    assert.equal(validateEmail("User@Example.COM", "email"), "user@example.com");
  });

  it("rejects missing domain", () => {
    expectHttpError(() => validateEmail("user@", "email"), 400);
  });

  it("rejects missing @", () => {
    expectHttpError(() => validateEmail("user.example.com", "email"), 400);
  });

  it("rejects oversized email (>254 chars)", () => {
    const long = "a".repeat(250) + "@b.com";
    expectHttpError(() => validateEmail(long, "email"), 400);
  });

  it("rejects non-string", () => {
    expectHttpError(() => validateEmail(123, "email"), 400);
  });
});

describe("validatePaginationInt", () => {
  it("parses a valid integer string", () => {
    assert.equal(validatePaginationInt("50", "limit"), 50);
  });

  it("clamps to max", () => {
    assert.equal(validatePaginationInt("999", "limit", { max: 200 }), 200);
  });

  it("rejects non-numeric", () => {
    expectHttpError(() => validatePaginationInt("abc", "limit"), 400, "positive integer");
  });

  it("rejects negative when min=1", () => {
    expectHttpError(() => validatePaginationInt("-5", "limit"), 400);
  });

  it("uses fallback for empty/undefined", () => {
    assert.equal(validatePaginationInt(undefined, "limit", { fallback: 50 }), 50);
    assert.equal(validatePaginationInt("", "limit", { fallback: 50 }), 50);
  });

  it("throws without fallback for empty", () => {
    expectHttpError(() => validatePaginationInt(undefined, "limit"), 400);
  });

  it("rejects mixed alphanumeric like '50x'", () => {
    expectHttpError(() => validatePaginationInt("50x", "limit"), 400, "positive integer");
  });
});

describe("validateURL", () => {
  it("accepts a valid HTTPS URL", () => {
    assert.equal(validateURL("https://example.com/webhook", "url"), "https://example.com/webhook");
  });

  it("rejects HTTP", () => {
    expectHttpError(() => validateURL("http://example.com", "url"), 400, "https://");
  });

  it("rejects malformed URL", () => {
    expectHttpError(() => validateURL("not-a-url", "url"), 400, "valid URL");
  });

  it("rejects localhost", () => {
    expectHttpError(() => validateURL("https://localhost/hook", "url"), 400, "valid hostname");
  });

  it("rejects non-string", () => {
    expectHttpError(() => validateURL(42, "url"), 400);
  });
});
