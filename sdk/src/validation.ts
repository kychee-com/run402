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
