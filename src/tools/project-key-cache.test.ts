import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleProjectKeyCacheExport } from "./project-key-cache-export.js";
import { handleProjectKeyCacheStatus } from "./project-key-cache-status.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-project-key-cache-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

function writeLegacyProjects(data: Record<string, unknown>) {
  writeFileSync(join(tempDir, "projects.json"), JSON.stringify(data), { mode: 0o600 });
}

describe("project_key_cache_status tool", () => {
  it("returns redacted project-key cache details", async () => {
    writeLegacyProjects({
      projects: {
        "proj-1": { anon_key: "ak-123456789", service_key: "sk-456789123", site_url: "https://example.run402.com" },
      },
    });

    const result = await handleProjectKeyCacheStatus({ project_id: "proj-1" });
    const text = result.content[0]!.text;
    assert.ok(text.includes("proj-1"));
    assert.ok(text.includes("local_cache"));
    assert.ok(text.includes("ak-12345..."));
    assert.ok(text.includes("sk-45678..."));
    assert.ok(!text.includes("ak-123456789"));
    assert.ok(!text.includes("sk-456789123"));
    assert.equal(result.isError, undefined);
  });
});

describe("project_key_cache_export tool", () => {
  it("requires reveal before returning local project keys", async () => {
    writeLegacyProjects({ projects: { "proj-1": { anon_key: "ak-123", service_key: "sk-456" } } });

    const result = await handleProjectKeyCacheExport({ project_id: "proj-1", reveal: false });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /REVEAL_REQUIRED|requires/);
  });

  it("returns keys only when reveal is true", async () => {
    writeLegacyProjects({ projects: { "proj-1": { anon_key: "ak-123", service_key: "sk-456" } } });

    const result = await handleProjectKeyCacheExport({ project_id: "proj-1", reveal: true });
    const text = result.content[0]!.text;
    assert.ok(text.includes("ak-123"));
    assert.ok(text.includes("sk-456"));
    assert.equal(result.isError, undefined);
  });
});
