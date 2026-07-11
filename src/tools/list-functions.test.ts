import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleListFunctions } from "./list-functions.js";
import { _resetSdk } from "../sdk.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-list-functions-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  writeFileSync(join(tempDir, "projects.json"), JSON.stringify({
    projects: {
      "proj-001": {
        anon_key: "ak-123",
        service_key: "sk-456",
        tier: "prototype",
        lease_expires_at: "2030-01-01T00:00:00Z",
      },
    },
  }));
  _resetSdk();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetSdk();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("list_functions tool", () => {
  it("renders deployed, current, minimum, and stale runtime metadata", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      functions: [
        {
          name: "priced-route",
          url: "https://test-api.run402.com/functions/v1/priced-route",
          runtime: "node22",
          timeout: 15,
          memory: 128,
          created_at: "2026-07-11T00:00:00Z",
          updated_at: "2026-07-11T00:00:00Z",
          runtime_version: "3.6.0",
          runtime_current_version: "3.8.0",
          runtime_minimum_version: "3.7.0",
          runtime_stale: true,
          deps_resolved: { zod: "3.25.0" },
        },
        {
          name: "legacy",
          url: "https://test-api.run402.com/functions/v1/legacy",
          runtime: "node22",
          timeout: 15,
          memory: 128,
          created_at: "2026-07-10T00:00:00Z",
          updated_at: "2026-07-10T00:00:00Z",
          runtime_version: null,
          runtime_current_version: "3.8.0",
          runtime_minimum_version: "3.7.0",
          runtime_stale: true,
          deps_resolved: null,
        },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

    const result = await handleListFunctions({ project_id: "proj-001" });

    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text;
    assert.match(text, /Functions runtime compatibility/);
    assert.match(text, /\| \*\*priced-route\*\* \| `3\.6\.0` \| `3\.8\.0` \| `3\.7\.0` \| stale \| 1 \|/);
    assert.match(text, /\| \*\*legacy\*\* \| legacy \/ unknown \| `3\.8\.0` \| `3\.7\.0` \| stale \| 0 \|/);
    assert.match(text, /functions_rebuild/);
    assert.match(text, /`zod@3\.25\.0`/);
  });
});
