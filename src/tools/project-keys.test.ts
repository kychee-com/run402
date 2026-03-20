import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleProjectKeys } from "./project-keys.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-project-keys-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
});

function writeKeystore(data: Record<string, unknown>) {
  writeFileSync(join(tempDir, "projects.json"), JSON.stringify(data), { mode: 0o600 });
}

describe("project_keys tool", () => {
  it("returns keys for project", async () => {
    writeKeystore({ projects: { "proj-1": { anon_key: "ak-123", service_key: "sk-456" } } });

    const result = await handleProjectKeys({ project_id: "proj-1" });
    const text = result.content[0]!.text;
    assert.ok(text.includes("ak-123"));
    assert.ok(text.includes("sk-456"));
    assert.equal(result.isError, undefined);
  });

  it("returns error for missing project", async () => {
    writeKeystore({ projects: {} });

    const result = await handleProjectKeys({ project_id: "nonexistent" });
    assert.equal(result.isError, true);
  });
});
