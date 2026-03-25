/**
 * Input validation utilities.
 *
 * Each validator returns the validated value on success or throws
 * HttpError(400) with a descriptive message on failure.
 */
import { HttpError } from "./async-handler.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate that `value` is a valid UUID (RFC 4122 format). */
export function validateUUID(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HttpError(400, `Invalid ${field}: must be a valid UUID`);
  }
  return value;
}

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

/** Validate a 42-character Ethereum hex address. */
export function validateWalletAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !WALLET_RE.test(value)) {
    throw new HttpError(400, `Invalid ${field}: must be a 42-character hex address starting with 0x`);
  }
  return value.toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;

/** Validate email format and length (max 254 chars per RFC 5321). */
export function validateEmail(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(value)) {
    throw new HttpError(400, `Invalid ${field}: must be a valid email address`);
  }
  return value.toLowerCase().trim();
}

/**
 * Parse and validate a pagination integer.
 * Returns the parsed integer clamped to [min, max].
 * Throws on non-numeric input.
 */
export function validatePaginationInt(
  value: unknown,
  field: string,
  { min = 1, max = 200, fallback }: { min?: number; max?: number; fallback?: number } = {},
): number {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, `Invalid ${field}: must be a positive integer`);
  }
  const str = String(value);
  if (!/^-?\d+$/.test(str)) {
    throw new HttpError(400, `Invalid ${field}: must be a positive integer`);
  }
  const n = parseInt(str, 10);
  if (n < min) {
    throw new HttpError(400, `Invalid ${field}: must be at least ${min}`);
  }
  return Math.min(n, max);
}

/** Validate that `value` is a well-formed HTTPS URL with a hostname. */
export function validateURL(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new HttpError(400, `Invalid ${field}: must be a URL string`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, `Invalid ${field}: must be a valid URL`);
  }
  if (url.protocol !== "https:") {
    throw new HttpError(400, `Invalid ${field}: must use https://`);
  }
  if (!url.hostname || url.hostname === "localhost") {
    throw new HttpError(400, `Invalid ${field}: must have a valid hostname`);
  }
  return value;
}
