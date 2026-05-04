import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  handleDeployReleaseActive,
  handleDeployReleaseDiff,
  handleDeployReleaseGet,
} from "./deploy-release.js";
import { _resetSdk } from "../sdk.js";

const originalFetch = globalThis.fetch;
let tempDir: string;
let seen: Array<{ path: string; apikey: string | null }> = [];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-deploy-release-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  writeFileSync(
    join(tempDir, "projects.json"),
    JSON.stringify({
      projects: {
        prj_test: { anon_key: "ak_test", service_key: "sk_test" },
      },
    }),
    { mode: 0o600 },
  );
  seen = [];
  _resetSdk();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  _resetSdk();
});

describe("deploy release observability MCP tools", () => {
  it("returns release inventory without requiring allowance auth", async () => {
    globalThis.fetch = makeFetch((path) => {
      assert.equal(path, "/deploy/v2/releases/rel_%2Fone?site_limit=2");
      return inventory({ release_id: "rel_/one", state_kind: "effective" });
    });

    const result = await handleDeployReleaseGet({
      project_id: "prj_test",
      release_id: "rel_/one",
      site_limit: 2,
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Release Inventory"));
    assert.ok(result.content[1]!.text.includes('"kind": "release_inventory"'));
    assert.deepEqual(seen, [
      { path: "/deploy/v2/releases/rel_%2Fone?site_limit=2", apikey: "ak_test" },
    ]);
  });

  it("returns active release inventory", async () => {
    globalThis.fetch = makeFetch((path) => {
      assert.equal(path, "/deploy/v2/releases/active");
      return inventory({ release_id: "rel_active", state_kind: "current_live" });
    });

    const result = await handleDeployReleaseActive({ project_id: "prj_test" });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Active Release Inventory"));
    assert.ok(result.content[0]!.text.includes("current_live"));
  });

  it("returns release diffs with applied_between_releases", async () => {
    globalThis.fetch = makeFetch((path) => {
      assert.equal(path, "/deploy/v2/releases/diff?from=empty&to=active&limit=4");
      return {
        kind: "release_diff",
        schema_version: "agent-deploy-observability.v1",
        from_release_id: null,
        to_release_id: "rel_active",
        is_noop: false,
        summary: "1 migration applied",
        warnings: [
          {
            code: "DIFF_TRUNCATED",
            severity: "warn",
            requires_confirmation: false,
            message: "Diff output was truncated.",
          },
        ],
        migrations: { applied_between_releases: ["001_init"] },
        site: { added: [], removed: [], changed: [] },
        functions: { added: [], removed: [], changed: [] },
        secrets: { added: [], removed: [] },
        subdomains: { added: [], removed: [] },
      };
    });

    const result = await handleDeployReleaseDiff({
      project_id: "prj_test",
      from: "empty",
      to: "active",
      limit: 4,
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Release Diff"));
    assert.ok(result.content[1]!.text.includes("applied_between_releases"));
    assert.ok(result.content[1]!.text.includes("DIFF_TRUNCATED"));
  });

  it("maps SDK errors from semantic release failures", async () => {
    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      seen.push({ path: `${url.pathname}${url.search}`, apikey: req.headers.get("apikey") });
      return new Response(
        JSON.stringify({ code: "NO_ACTIVE_RELEASE", message: "No active release." }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleDeployReleaseActive({ project_id: "prj_test" });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("NO_ACTIVE_RELEASE"));
    assert.deepEqual(seen, [
      { path: "/deploy/v2/releases/active", apikey: "ak_test" },
    ]);
  });
});

function makeFetch(handler: (path: string) => unknown): typeof fetch {
  return (async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const path = `${url.pathname}${url.search}`;
    seen.push({ path, apikey: req.headers.get("apikey") });
    return new Response(JSON.stringify(handler(path)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function inventory(opts: { release_id: string; state_kind: string }) {
  return {
    kind: "release_inventory",
    schema_version: "agent-deploy-observability.v1",
    release_id: opts.release_id,
    project_id: "prj_test",
    parent_id: null,
    status: "active",
    manifest_digest: "abc123",
    created_at: "2026-05-04T00:00:00Z",
    created_by: "0xtest",
    activated_at: "2026-05-04T00:01:00Z",
    superseded_at: null,
    operation_id: null,
    plan_id: null,
    events_url: null,
    effective: true,
    state_kind: opts.state_kind,
    site: { paths: [] },
    functions: [],
    secrets: { keys: [] },
    subdomains: { names: [] },
    migrations_applied: [],
  };
}
