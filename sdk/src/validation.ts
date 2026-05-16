import { LocalError } from "./errors.js";

export function assertPositiveSafeInteger(
  value: number,
  name: string,
  context: string,
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LocalError(`${name} must be a positive safe integer.`, context);
  }
}

export function assertWeiString(
  value: unknown,
  name: string,
  context: string,
): asserts value is string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new LocalError(`${name} must be a decimal non-negative integer string in wei.`, context);
  }
}

export function assertEvmAddress(
  value: unknown,
  name: string,
  context: string,
): asserts value is string {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new LocalError(`${name} must be a 0x-prefixed 20-byte EVM address.`, context);
  }
}

export function assertNonEmptyString(
  value: unknown,
  name: string,
  context: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LocalError(`${name} must be a non-empty string.`, context);
  }
}

export function assertEmailAddress(
  value: unknown,
  name: string,
  context: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  ) {
    throw new LocalError(`${name} must be a valid email address.`, context);
  }
}

export function assertHttpUrl(
  value: unknown,
  name: string,
  context: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LocalError(`${name} must be an http(s) URL.`, context);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalError(`${name} must be an http(s) URL.`, context);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LocalError(`${name} must be an http(s) URL.`, context);
  }
}

export function assertStringInSet<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
  context: string,
): asserts value is T {
  if (typeof value !== "string") {
    throw new LocalError(`${name} must be one of: ${allowed.join(", ")}.`, context);
  }
  if (!allowed.includes(value as T)) {
    throw new LocalError(`${name} must be one of: ${allowed.join(", ")}.`, context);
  }
}
