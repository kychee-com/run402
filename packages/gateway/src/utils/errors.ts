/** Safely extract an error message from an unknown caught value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Type guard: check if an unknown error has a `code` property (e.g. Postgres errors). */
export function hasCode(err: unknown): err is Error & { code: string } {
  return err instanceof Error && typeof (err as unknown as Record<string, unknown>).code === "string";
}

/** Type guard: check if an unknown error has a `name` property matching a value. */
export function hasName(err: unknown, name: string): err is Error {
  return err instanceof Error && err.name === name;
}
