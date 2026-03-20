import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleProjectUse } from "./project-use.js";
import { getActiveProjectId } from "../keystore.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-project-use-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
});

function writeKeystore(data: Record<string, unknown>) {
  writeFileSync(join(tempDir, "projects.json"), JSON.stringify(data), { mode: 0o600 });
}

describe("project_use tool", () => {
  it("sets active project", async () => {
    writeKeystore({ projects: { "proj-1": { anon_key: "ak", service_key: "sk" } } });

    const result = await handleProjectUse({ project_id: "proj-1" });
    const text = result.content[0]!.text;
    assert.ok(text.includes("proj-1"));
    assert.equal(result.isError, undefined);

    const storePath = join(tempDir, "projects.json");
    assert.equal(getActiveProjectId(storePath), "proj-1");
  });

  it("returns error for missing project", async () => {
    writeKeystore({ projects: {} });

    const result = await handleProjectUse({ project_id: "nonexistent" });
    assert.equal(result.isError, true);
  });
});
