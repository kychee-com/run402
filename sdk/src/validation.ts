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
  value: string,
  name: string,
  context: string,
): void {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new LocalError(`${name} must be a decimal non-negative integer string in wei.`, context);
  }
}

export function assertEvmAddress(
  value: string,
  name: string,
  context: string,
): void {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new LocalError(`${name} must be a 0x-prefixed 20-byte EVM address.`, context);
  }
}

export function assertStringInSet<T extends string>(
  value: string,
  allowed: readonly T[],
  name: string,
  context: string,
): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw new LocalError(`${name} must be one of: ${allowed.join(", ")}.`, context);
  }
}
