import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { errorMessage, hasCode, hasName } from "./errors.js";

describe("errorMessage", () => {
  it("extracts message from Error", () => {
    assert.equal(errorMessage(new Error("test")), "test");
  });

  it("converts non-Error to string", () => {
    assert.equal(errorMessage("raw string"), "raw string");
    assert.equal(errorMessage(42), "42");
    assert.equal(errorMessage(null), "null");
    assert.equal(errorMessage(undefined), "undefined");
  });
});

describe("hasCode", () => {
  it("returns true for Error with code", () => {
    const err = Object.assign(new Error("db error"), { code: "42P01" });
    assert.ok(hasCode(err));
    if (hasCode(err)) assert.equal(err.code, "42P01");
  });

  it("returns false for Error without code", () => {
    assert.ok(!hasCode(new Error("no code")));
  });

  it("returns false for non-Error", () => {
    assert.ok(!hasCode("string"));
    assert.ok(!hasCode({ code: "42P01" }));
  });
});

describe("hasName", () => {
  it("returns true when name matches", () => {
    const err = new TypeError("bad type");
    assert.ok(hasName(err, "TypeError"));
  });

  it("returns false when name does not match", () => {
    assert.ok(!hasName(new Error("test"), "TypeError"));
  });

  it("returns false for non-Error", () => {
    assert.ok(!hasName("not an error", "Error"));
  });
});
