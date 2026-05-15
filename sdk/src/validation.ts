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
