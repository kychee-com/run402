import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { canonicalize } from "json-canonicalize";

import {
  PaymentAttestationVerificationError,
  verifyOutcomeAttestationChain,
  verifyPaymentAttestation,
  type PaymentAttestationKey,
} from "./payment-attestation-verifier.js";
import type { VerifiedPaymentAttestation } from "../namespaces/pay.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });

function key(overrides: Partial<PaymentAttestationKey> = {}): PaymentAttestationKey {
  return {
    kid: "payment-key-1", use: "sig", alg: "ES256", kty: "EC", crv: "P-256",
    x: jwk.x!, y: jwk.y!, status: "active",
    valid_from: "2026-07-31T00:00:00.000Z",
    valid_until: "2026-08-01T00:00:00.000Z",
    compromise_cutoff: null,
    ...overrides,
  };
}

function compact(kind: "settlement" | "outcome", claims: Record<string, unknown>): string {
  const protectedHeader = {
    alg: "ES256", kid: "payment-key-1",
    typ: kind === "settlement"
      ? "run402-settlement-attestation+jws" : "run402-outcome-attestation+jws",
  };
  const body = {
    ...claims,
    issuer: "https://api.run402.test",
    schema: kind === "settlement"
      ? "run402_settlement_attestation_v1" : "run402_outcome_attestation_v1",
    key_id: "payment-key-1",
  };
  const header = Buffer.from(canonicalize(protectedHeader)).toString("base64url");
  const payload = Buffer.from(canonicalize(body)).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`, "ascii"), {
    key: privateKey, dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("Run402 payment attestation verifier", () => {
  it("verifies canonical ES256 settlement evidence with active or retired keys", () => {
    const value = compact("settlement", {
      settled_at: "2026-07-31T12:00:00.000Z", intent_id: "pint_1",
    });
    for (const status of ["active", "retired"] as const) {
      const verified = verifyPaymentAttestation({
        compactJws: value, kind: "settlement", keys: [key({ status })],
        issuer: "https://api.run402.test",
      });
      assert.equal(verified.verified, true);
      assert.equal(verified.claims.intent_id, "pint_1");
    }
  });

  it("does not accept revoked-key evidence on either side of the compromise cutoff", () => {
    const value = compact("settlement", {
      settled_at: "2026-07-31T12:00:00.000Z", intent_id: "pint_1",
    });
    assert.throws(() => verifyPaymentAttestation({
      compactJws: value, kind: "settlement",
      keys: [key({ status: "revoked", compromise_cutoff: "2026-07-31T13:00:00.000Z" })],
      issuer: "https://api.run402.test",
    }), (error: unknown) => error instanceof PaymentAttestationVerificationError &&
      error.code === "PAYMENT_EVIDENCE_KEY_REVIEW_REQUIRED");
    assert.throws(() => verifyPaymentAttestation({
      compactJws: value, kind: "settlement",
      keys: [key({ status: "revoked", compromise_cutoff: "2026-07-31T11:00:00.000Z" })],
      issuer: "https://api.run402.test",
    }), (error: unknown) => error instanceof PaymentAttestationVerificationError &&
      error.code === "PAYMENT_EVIDENCE_KEY_REJECTED");
  });

  it("requires an unbroken ordered outcome chain and stops after terminal", () => {
    const first: VerifiedPaymentAttestation = {
      kind: "outcome", compactJws: "one", claims: {
        outcome_sequence: 1, prior_attestation_digest: null, terminal: false,
      }, keyId: "payment-key-1", claimsDigest: createHash("sha256").update("one").digest("hex"), verified: true,
    };
    const second: VerifiedPaymentAttestation = {
      kind: "outcome", compactJws: "two", claims: {
        outcome_sequence: 2, prior_attestation_digest: first.claimsDigest, terminal: true,
      }, keyId: "payment-key-1", claimsDigest: createHash("sha256").update("two").digest("hex"), verified: true,
    };
    assert.doesNotThrow(() => verifyOutcomeAttestationChain([second, first]));
    assert.throws(() => verifyOutcomeAttestationChain([
      first,
      { ...second, claims: { ...second.claims, prior_attestation_digest: "wrong" } },
    ]), PaymentAttestationVerificationError);
  });
});
