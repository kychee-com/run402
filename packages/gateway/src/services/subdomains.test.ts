import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateSubdomainName } from "./subdomains.js";

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
