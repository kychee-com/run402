import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalize } from "json-canonicalize";

import type { VerifiedPaymentAttestation } from "../namespaces/pay.js";

type PaymentAttestationKeyStatus = "active" | "retired" | "revoked";

export interface PaymentAttestationKey {
  kid: string;
  use: "sig";
  alg: "ES256";
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  status: PaymentAttestationKeyStatus;
  valid_from: string;
  valid_until: string | null;
  compromise_cutoff: string | null;
}

const ATTESTATION_TYPES = {
  settlement: {
    typ: "run402-settlement-attestation+jws",
    schema: "run402_settlement_attestation_v1",
  },
  outcome: {
    typ: "run402-outcome-attestation+jws",
    schema: "run402_outcome_attestation_v1",
  },
} as const;

export class PaymentAttestationVerificationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "PaymentAttestationVerificationError";
  }
}

export async function fetchPaymentAttestationKeys(input: {
  origin: string;
  fetchImpl?: typeof fetch;
}): Promise<PaymentAttestationKey[]> {
  const origin = new URL(input.origin);
  const response = await (input.fetchImpl ?? fetch)(
    new URL("/.well-known/x402", origin),
    { headers: { accept: "application/json" }, redirect: "error" },
  ).catch(() => null);
  if (!response?.ok || response.redirected || !response.url ||
      new URL(response.url).origin !== origin.origin) {
    throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_UNAVAILABLE");
  }
  let body: unknown;
  try { body = await response.json(); } catch {
    throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
  }
  const keys = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).run402_payment_attestation_keys : null;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 32) {
    throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
  }
  const parsed = keys.map(paymentAttestationKey);
  if (new Set(parsed.map((key) => key.kid)).size !== parsed.length) {
    throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
  }
  return parsed;
}

export function verifyPaymentAttestation(input: {
  compactJws: string;
  kind: "settlement" | "outcome";
  keys: readonly PaymentAttestationKey[];
  issuer: string;
}): VerifiedPaymentAttestation {
  const segments = input.compactJws.split(".");
  if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
    throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
  }
  const [protectedEncoded, payloadEncoded, signatureEncoded] = segments as [string, string, string];
  const protectedBytes = Buffer.from(protectedEncoded, "base64url");
  const payloadBytes = Buffer.from(payloadEncoded, "base64url");
  const signature = Buffer.from(signatureEncoded, "base64url");
  if (signature.length !== 64 || protectedBytes.length > 2_048 || payloadBytes.length > 32_768) {
    throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
  }
  let protectedHeader: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    protectedHeader = jsonRecord(protectedBytes.toString("utf8"));
    claims = jsonRecord(payloadBytes.toString("utf8"));
  } catch {
    throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
  }
  if (Buffer.from(canonicalize(protectedHeader), "utf8").compare(protectedBytes) !== 0 ||
      Buffer.from(canonicalize(claims), "utf8").compare(payloadBytes) !== 0) {
    throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
  }
  const expected = ATTESTATION_TYPES[input.kind];
  const kid = protectedHeader.kid;
  if (protectedHeader.alg !== "ES256" || protectedHeader.typ !== expected.typ ||
      typeof kid !== "string" || claims.schema !== expected.schema || claims.key_id !== kid ||
      claims.issuer !== new URL(input.issuer).origin) {
    throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
  }
  const key = input.keys.find((candidate) => candidate.kid === kid);
  if (!key) throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_KEY_NOT_FOUND");
  const asOf = attestationInstant(input.kind, claims);
  validateKeyAt(key, asOf);
  const signingInput = Buffer.from(`${protectedEncoded}.${payloadEncoded}`, "ascii");
  let valid = false;
  try {
    valid = verify(
      "sha256",
      signingInput,
      {
        key: createPublicKey({ key: {
          kty: key.kty,
          crv: key.crv,
          x: key.x,
          y: key.y,
        }, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      },
      signature,
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
  return {
    kind: input.kind,
    compactJws: input.compactJws,
    claims,
    keyId: kid,
    claimsDigest: createHash("sha256").update(payloadBytes).digest("hex"),
    verified: true,
  };
}

export function verifyOutcomeAttestationChain(
  outcomes: readonly VerifiedPaymentAttestation[],
): void {
  const sorted = [...outcomes].sort((left, right) =>
    Number(left.claims.outcome_sequence) - Number(right.claims.outcome_sequence));
  let priorDigest: string | null = null;
  let terminal = false;
  for (let index = 0; index < sorted.length; index += 1) {
    const outcome = sorted[index]!;
    const sequence = outcome.claims.outcome_sequence;
    if (outcome.kind !== "outcome" || sequence !== index + 1 ||
        outcome.claims.prior_attestation_digest !== priorDigest || terminal) {
      throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_CHAIN_INVALID");
    }
    priorDigest = outcome.claimsDigest;
    terminal = outcome.claims.terminal === true;
  }
}

function paymentAttestationKey(value: unknown): PaymentAttestationKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
  }
  const item = value as Record<string, unknown>;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(item.kid ?? "")) || item.use !== "sig" ||
      item.alg !== "ES256" || item.kty !== "EC" || item.crv !== "P-256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(String(item.x ?? "")) ||
      !/^[A-Za-z0-9_-]{43}$/.test(String(item.y ?? "")) ||
      !new Set(["active", "retired", "revoked"]).has(String(item.status)) ||
      !isoInstant(item.valid_from) ||
      !(item.valid_until === null || isoInstant(item.valid_until)) ||
      !(item.compromise_cutoff === null || isoInstant(item.compromise_cutoff))) {
    throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
  }
  const key = item as unknown as PaymentAttestationKey;
  if (key.valid_until && key.valid_until <= key.valid_from) {
    throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
  }
  return key;
}

function validateKeyAt(key: PaymentAttestationKey, instant: Date): void {
  const value = instant.toISOString();
  if (value < key.valid_from || (key.valid_until && value >= key.valid_until)) {
    throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_KEY_REJECTED");
  }
  if (key.status === "revoked") {
    throw new PaymentAttestationVerificationError(
      key.compromise_cutoff && value < key.compromise_cutoff
        ? "PAYMENT_EVIDENCE_KEY_REVIEW_REQUIRED"
        : "PAYMENT_EVIDENCE_KEY_REJECTED",
    );
  }
}

function attestationInstant(
  kind: "settlement" | "outcome",
  claims: Record<string, unknown>,
): Date {
  const value = kind === "settlement" ? claims.settled_at : claims.as_of;
  if (!isoInstant(value)) {
    throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
  }
  return new Date(value);
}

function isoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function jsonRecord(text: string): Record<string, unknown> {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
  }
  return value as Record<string, unknown>;
}
