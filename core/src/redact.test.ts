import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeRejectedValue } from "./redact.js";

describe("describeRejectedValue", () => {
  it("returns short, plain typos unchanged", () => {
    for (const typo of ["Foo", "-leading", "with space", "../evil", "a/b", "..", "lst", "projcts", ""]) {
      assert.equal(describeRejectedValue(typo), typo);
    }
  });

  it("does not redact a well-formed UUID (the shape of a valid org id)", () => {
    const uuid = "11111111-1111-4111-8111-111111111111"; // 36 chars
    assert.equal(describeRejectedValue(uuid), uuid);
  });

  it("redacts a 0x-prefixed 64-hex private key (kychee-com/run402-private#640)", () => {
    const privateKey = "0x" + "22".repeat(32); // 66 chars, the exact shape of the incident
    const out = describeRejectedValue(privateKey);
    assert.notEqual(out, privateKey);
    assert.doesNotMatch(out, /22/);
    for (let i = 0; i < privateKey.length - 8; i++) {
      assert.ok(!out.includes(privateKey.slice(i, i + 8)), `output must not contain a substring of the secret: ${privateKey.slice(i, i + 8)}`);
    }
    assert.match(out, /66 chars/);
  });

  it("redacts a bare 64-hex private key with no 0x prefix", () => {
    const privateKey = "a".repeat(64);
    const out = describeRejectedValue(privateKey);
    assert.notEqual(out, privateKey);
    assert.doesNotMatch(out, /a{8}/);
    assert.match(out, /64 chars/);
  });

  it("redacts any long value regardless of charset", () => {
    const long = "not-hex-but-still-a-very-long-pasted-value-nobody-typed-by-hand";
    const out = describeRejectedValue(long);
    assert.notEqual(out, long);
    assert.doesNotMatch(out, /nobody-typed-by-hand/);
  });

  it("redacts a short hex-looking run even under the length cap", () => {
    const shortHex = "deadbeefcafebabe"; // 16 hex chars, well under the 24-char safe-echo cap
    const out = describeRejectedValue(shortHex);
    assert.notEqual(out, shortHex);
    assert.doesNotMatch(out, /deadbeef/);
  });

  it("never returns a substring of a redacted value", () => {
    const secret = "0x" + "beef".repeat(16); // 66 chars
    const out = describeRejectedValue(secret);
    for (let len = 4; len <= 12; len++) {
      for (let i = 0; i <= secret.length - len; i++) {
        assert.ok(!out.includes(secret.slice(i, i + len)));
      }
    }
  });

  it("coerces non-string input instead of throwing", () => {
    assert.equal(describeRejectedValue(undefined), "");
    assert.equal(describeRejectedValue(null), "");
    assert.equal(describeRejectedValue(42), "42");
  });
});
