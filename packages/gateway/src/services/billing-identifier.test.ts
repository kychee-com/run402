import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { resolveAccountIdentifier } = await import("./billing-identifier.js");

describe("resolveAccountIdentifier", () => {
  it("detects wallet address (0x + 40 hex chars)", () => {
    const result = resolveAccountIdentifier("0x1234567890abcdef1234567890abcdef12345678");
    assert.equal(result.type, "wallet");
    assert.equal(result.value, "0x1234567890abcdef1234567890abcdef12345678");
  });

  it("normalizes wallet address to lowercase", () => {
    const result = resolveAccountIdentifier("0xABCDEF1234567890ABCDEF1234567890ABCDEF12");
    assert.equal(result.type, "wallet");
    assert.equal(result.value, "0xabcdef1234567890abcdef1234567890abcdef12");
  });

  it("detects email address", () => {
    const result = resolveAccountIdentifier("user@example.com");
    assert.equal(result.type, "email");
    assert.equal(result.value, "user@example.com");
  });

  it("normalizes email to lowercase and trimmed", () => {
    const result = resolveAccountIdentifier("  User@Example.COM  ");
    assert.equal(result.type, "email");
    assert.equal(result.value, "user@example.com");
  });

  it("throws HttpError 400 for invalid identifier", () => {
    assert.throws(
      () => resolveAccountIdentifier("not-a-wallet-or-email"),
      (err: unknown) => {
        const e = err as { statusCode?: number; message?: string };
        return e.statusCode === 400;
      },
    );
  });

  it("throws HttpError 400 for empty string", () => {
    assert.throws(
      () => resolveAccountIdentifier(""),
      (err: unknown) => (err as { statusCode?: number }).statusCode === 400,
    );
  });

  it("throws HttpError 400 for wallet that's too short", () => {
    assert.throws(
      () => resolveAccountIdentifier("0x12345"),
      (err: unknown) => (err as { statusCode?: number }).statusCode === 400,
    );
  });

  it("throws HttpError 400 for wallet with invalid hex", () => {
    assert.throws(
      () => resolveAccountIdentifier("0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"),
      (err: unknown) => (err as { statusCode?: number }).statusCode === 400,
    );
  });

  it("throws HttpError 400 for malformed email", () => {
    assert.throws(
      () => resolveAccountIdentifier("user@"),
      (err: unknown) => (err as { statusCode?: number }).statusCode === 400,
    );
  });
});
