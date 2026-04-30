import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleProjectInfo } from "./project-info.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-project-info-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

function writeKeystore(data: Record<string, unknown>) {
  writeFileSync(join(tempDir, "projects.json"), JSON.stringify(data), { mode: 0o600 });
}

describe("project_info tool", () => {
  it("returns project details from keystore", async () => {
    writeKeystore({
      projects: {
        "proj-1": { anon_key: "ak-123", service_key: "sk-456", site_url: "https://example.run402.com" },
      },
    });

    const result = await handleProjectInfo({ project_id: "proj-1" });
    const text = result.content[0]!.text;
    assert.ok(text.includes("proj-1"));
    assert.ok(text.includes("ak-123"));
    assert.ok(text.includes("sk-456"));
    assert.ok(text.includes("https://example.run402.com"));
    assert.ok(text.includes("rest/v1"));
    assert.equal(result.isError, undefined);
  });

  it("returns error for missing project", async () => {
    writeKeystore({ projects: {} });

    const result = await handleProjectInfo({ project_id: "nonexistent" });
    assert.equal(result.isError, true);
  });
});
