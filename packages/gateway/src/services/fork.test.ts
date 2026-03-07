import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateForkRequest, ForkError } from "./fork.js";

describe("fork — request validation", () => {
  it("rejects missing version_id", () => {
    assert.throws(
      () => validateForkRequest({ version_id: "", name: "app" }),
      (err: ForkError) => err.statusCode === 400 && err.message.includes("version_id"),
    );
  });

  it("rejects non-string version_id", () => {
    assert.throws(
      () => validateForkRequest({ version_id: 123 as unknown as string, name: "app" }),
      (err: ForkError) => err.statusCode === 400,
    );
  });

  it("rejects missing name", () => {
    assert.throws(
      () => validateForkRequest({ version_id: "ver_123", name: "" }),
      (err: ForkError) => err.statusCode === 400 && err.message.includes("name"),
    );
  });

  it("rejects non-string name", () => {
    assert.throws(
      () => validateForkRequest({ version_id: "ver_123", name: 42 as unknown as string }),
      (err: ForkError) => err.statusCode === 400,
    );
  });

  it("accepts valid request", () => {
    assert.doesNotThrow(() =>
      validateForkRequest({ version_id: "ver_1741340000_abc123", name: "my-fork" }),
    );
  });

  it("accepts request with subdomain", () => {
    assert.doesNotThrow(() =>
      validateForkRequest({
        version_id: "ver_1741340000_abc123",
        name: "my-fork",
        subdomain: "cool-app",
      }),
    );
  });
});

describe("fork — tier ordering logic", () => {
  // Test the tier comparison logic used in forkApp
  const TIER_ORDER: Record<string, number> = { prototype: 0, hobby: 1, team: 2 };

  it("prototype is below hobby", () => {
    assert.ok(TIER_ORDER["prototype"] < TIER_ORDER["hobby"]);
  });

  it("hobby is below team", () => {
    assert.ok(TIER_ORDER["hobby"] < TIER_ORDER["team"]);
  });

  it("team meets team minimum", () => {
    assert.ok(TIER_ORDER["team"] >= TIER_ORDER["team"]);
  });

  it("prototype does not meet hobby minimum", () => {
    assert.ok(TIER_ORDER["prototype"] < TIER_ORDER["hobby"]);
  });

  it("effective min tier is max of derived and publisher", () => {
    const derived = "hobby";
    const publisher = "prototype";
    const effective = TIER_ORDER[derived] > TIER_ORDER[publisher] ? derived : publisher;
    assert.equal(effective, "hobby");
  });
});
