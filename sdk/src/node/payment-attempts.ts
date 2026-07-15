/**
 * Sanitized local journal for automatic x402 payment attempts.
 *
 * Each attempt is a separate mode-0600 file. Separate files avoid lost
 * updates when multiple SDK processes pay concurrently. Records intentionally
 * exclude request headers, query strings, bodies, wallet keys, signed payment
 * authorizations, and provider proofs.
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfigDir } from "../../core-dist/config.js";
import { LocalError } from "../errors.js";

export const PAYMENT_ATTEMPT_HEADER = "X-Run402-Payment-Attempt-Id";
export const PAYMENT_ATTEMPT_ID_PATTERN = /^pat_[0-9a-f]{32}$/;

export type PaymentAttemptJournalState =
  | "intent"
  | "submitting"
  | "response_received"
  | "completed"
  | "failed"
  | "ambiguous";

export interface PaymentAttemptRecord {
  version: 1;
  payment_attempt_id: string;
  rail: "x402";
  state: PaymentAttemptJournalState;
  mutation_state: "not_started" | "in_progress" | "completed" | "ambiguous";
  method: string;
  origin: string | null;
  path: string | null;
  created_at: string;
  updated_at: string;
  provider_started_at?: string;
  response_status?: number;
  last_error_code?: string;
}

export interface PaymentAttemptStore {
  write(record: PaymentAttemptRecord): void;
  read(paymentAttemptId: string): PaymentAttemptRecord | null;
}

export function createPaymentAttemptId(): string {
  return `pat_${randomUUID().replaceAll("-", "")}`;
}

export function paymentAttemptJournalDir(): string {
  return join(getConfigDir(), "payment-attempts");
}

export function createFilePaymentAttemptStore(
  dir = paymentAttemptJournalDir(),
): PaymentAttemptStore {
  return {
    write(record) {
      assertPaymentAttemptId(record.payment_attempt_id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const path = join(dir, `${record.payment_attempt_id}.json`);
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        renameSync(tmp, path);
        chmodSync(path, 0o600);
      } finally {
        rmSync(tmp, { force: true });
      }
    },
    read(paymentAttemptId) {
      assertPaymentAttemptId(paymentAttemptId);
      try {
        const parsed = JSON.parse(
          readFileSync(join(dir, `${paymentAttemptId}.json`), "utf8"),
        ) as unknown;
        return isPaymentAttemptRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
  };
}

/** Read one sanitized attempt from the active wallet profile's journal. */
export function readPaymentAttempt(paymentAttemptId: string): PaymentAttemptRecord | null {
  return createFilePaymentAttemptStore().read(paymentAttemptId);
}

/**
 * List recent sanitized attempts for reconciliation. This is a local read;
 * provider/target state remains authoritative for ambiguous attempts.
 */
export function listPaymentAttempts(opts: { limit?: number } = {}): PaymentAttemptRecord[] {
  const limit = Math.max(1, Math.min(100, Math.trunc(opts.limit ?? 20)));
  const dir = paymentAttemptJournalDir();
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^pat_[0-9a-f]{32}\.json$/.test(name));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      try {
        const path = join(dir, name);
        const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
        return isPaymentAttemptRecord(parsed)
          ? { record: parsed, mtimeMs: statSync(path).mtimeMs }
          : null;
      } catch {
        return null;
      }
    })
    .filter((item): item is { record: PaymentAttemptRecord; mtimeMs: number } => item !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((item) => item.record);
}

export function requestSummary(input: RequestInfo | URL, init?: RequestInit): {
  method: string;
  origin: string | null;
  path: string | null;
} {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return { method, origin: url.origin, path: url.pathname };
  } catch {
    return { method, origin: null, path: null };
  }
}

export function attemptIdFromRequest(input: RequestInfo | URL, init?: RequestInit): string | null {
  const headers = mergedHeaders(input, init);
  const supplied = headers.get(PAYMENT_ATTEMPT_HEADER);
  return supplied && PAYMENT_ATTEMPT_ID_PATTERN.test(supplied) ? supplied : null;
}

export function withPaymentAttemptHeader(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  paymentAttemptId: string,
  paymentBearing: boolean,
): [RequestInfo | URL, RequestInit] {
  const headers = mergedHeaders(input, init);
  // Reserved correlation metadata is sent only with the payment-bearing call,
  // never the unpriced discovery request. `redirect: "error"` prevents both
  // this id and the signed payment authorization from being forwarded to a
  // redirect target (especially an unrelated origin).
  headers.delete(PAYMENT_ATTEMPT_HEADER);
  if (paymentBearing) headers.set(PAYMENT_ATTEMPT_HEADER, paymentAttemptId);
  return [input, { ...init, headers, ...(paymentBearing ? { redirect: "error" } : {}) }];
}

export function hasPaymentAuthorization(input: RequestInfo | URL, init?: RequestInit): boolean {
  const headers = mergedHeaders(input, init);
  return headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
}

function mergedHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

function assertPaymentAttemptId(value: string): void {
  if (!PAYMENT_ATTEMPT_ID_PATTERN.test(value)) {
    throw new LocalError(
      "Payment attempt id must match pat_ followed by 32 lowercase hexadecimal characters.",
      "reading x402 payment attempt",
      { code: "INVALID_PAYMENT_ATTEMPT_ID", details: { field: "paymentAttemptId" } },
    );
  }
}

function isPaymentAttemptRecord(value: unknown): value is PaymentAttemptRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<PaymentAttemptRecord>;
  return (
    record.version === 1 &&
    typeof record.payment_attempt_id === "string" &&
    PAYMENT_ATTEMPT_ID_PATTERN.test(record.payment_attempt_id) &&
    record.rail === "x402" &&
    typeof record.state === "string" &&
    typeof record.mutation_state === "string" &&
    typeof record.method === "string" &&
    (record.origin === null || typeof record.origin === "string") &&
    (record.path === null || typeof record.path === "string") &&
    typeof record.created_at === "string" &&
    typeof record.updated_at === "string"
  );
}
