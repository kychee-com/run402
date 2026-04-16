import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePgBinary } from "./pg-binaries.js";

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolvePgBinary", () => {
  it("uses explicit env overrides when provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-pg-dump-"));
    tempDirs.push(dir);
    const pgDumpPath = join(dir, "custom-pg-dump");
    writeFileSync(pgDumpPath, "#!/bin/sh\nexit 0\n");
    chmodSync(pgDumpPath, 0o755);
    process.env.PG_DUMP_PATH = pgDumpPath;
    assert.equal(resolvePgBinary("pg_dump"), pgDumpPath);
  });

  it("uses PG_BIN_DIR when the binary exists there", () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-pg-bin-"));
    tempDirs.push(dir);
    const psqlPath = join(dir, "psql");
    writeFileSync(psqlPath, "#!/bin/sh\nexit 0\n");
    chmodSync(psqlPath, 0o755);
    process.env.PG_BIN_DIR = dir;
    delete process.env.PSQL_PATH;
    assert.equal(resolvePgBinary("psql"), psqlPath);
  });
});
