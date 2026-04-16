import { existsSync } from "node:fs";
import { join } from "node:path";

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

/**
 * Resolve a PostgreSQL client binary, including common Homebrew keg-only paths.
 * Falls back to the bare command name so environments with PATH already set
 * keep working unchanged.
 */
export function resolvePgBinary(name: "pg_dump" | "psql"): string {
  const envOverride = name === "pg_dump" ? process.env.PG_DUMP_PATH : process.env.PSQL_PATH;
  const pgBinDir = process.env.PG_BIN_DIR || "";

  const candidates = dedupe([
    envOverride || "",
    pgBinDir ? join(pgBinDir, name) : "",
    `/opt/homebrew/opt/libpq/bin/${name}`,
    `/usr/local/opt/libpq/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    name,
  ]);

  for (const candidate of candidates) {
    if (candidate === name || existsSync(candidate)) return candidate;
  }

  return name;
}
