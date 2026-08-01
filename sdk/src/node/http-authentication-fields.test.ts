import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AuthenticationFieldError,
  authenticationParameterObject,
  parseAuthenticationFields,
} from "./http-authentication-fields.js";

describe("RFC 9110 authentication field parser", () => {
  it("parses coalesced schemes, token68, quoted commas, and quoted-pair escapes", () => {
    const parsed = parseAuthenticationFields([
      'Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==, Payment challenge="alpha,beta\\\"gamma", method=lightning, intent=charge',
      'Bearer abc.def_~+/',
    ]);
    assert.equal(parsed.challenges.length, 3);
    assert.equal(parsed.challenges[0]!.normalizedScheme, "basic");
    assert.equal(parsed.challenges[0]!.token68, "QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
    const payment = parsed.challenges[1]!;
    assert.equal(payment.raw,
      'Payment challenge="alpha,beta\\\"gamma", method=lightning, intent=charge');
    assert.deepEqual(authenticationParameterObject(payment), {
      challenge: 'alpha,beta"gamma',
      method: "lightning",
      intent: "charge",
    });
    assert.equal(parsed.challenges[2]!.token68, "abc.def_~+/");
  });

  for (const fixture of [
    { id: "duplicate parameter", value: "Payment method=lightning, METHOD=tempo" },
    { id: "unclosed quote", value: 'Payment method="lightning' },
    { id: "dangling escape", value: 'Payment method="lightning\\' },
    { id: "control character", value: "Payment method=lightning\u0000" },
  ]) {
    it(`rejects malicious fixture: ${fixture.id}`, () => {
      assert.throws(() => parseAuthenticationFields([fixture.value]), AuthenticationFieldError);
    });
  }

  it("accepts token68 without equals and RFC list empty members without ambiguity", () => {
    const parsed = parseAuthenticationFields(["Payment method,,Basic abc"]);
    assert.equal(parsed.challenges[0]!.token68, "method");
    assert.equal(parsed.challenges[1]!.normalizedScheme, "basic");
  });

  it("enforces field-count and aggregate-byte limits", () => {
    assert.throws(() => parseAuthenticationFields(Array.from({ length: 17 }, () => "Basic abc")),
      AuthenticationFieldError);
    assert.throws(() => parseAuthenticationFields([`Basic ${"a".repeat(33_000)}`]),
      AuthenticationFieldError);
  });
});
