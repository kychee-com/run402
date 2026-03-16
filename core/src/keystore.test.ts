import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadKeyStore, saveKeyStore, getProject, saveProject, removeProject } from "./keystore.js";
import type { StoredProject, KeyStore } from "./keystore.js";

let tempDir: string;
let storePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-core-keystore-test-"));
  storePath = join(tempDir, "projects.json");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("core keystore", () => {
  it("returns empty store when file does not exist", () => {
    const store = loadKeyStore(storePath);
    assert.deepEqual(store, { projects: {} });
  });

  it("saves and loads a project", () => {
    const project: StoredProject = {
      anon_key: "anon-key-123",
      service_key: "svc-key-456",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    };
    saveProject("proj-001", project, storePath);
    const loaded = getProject("proj-001", storePath);
    assert.deepEqual(loaded, project);
  });

  it("creates file with 0600 permissions", () => {
    saveProject("proj-002", {
      anon_key: "ak", service_key: "sk", tier: "hobby",
      lease_expires_at: "2026-04-01T00:00:00Z",
    }, storePath);
    const stats = statSync(storePath);
    const mode = stats.mode & 0o777;
    assert.equal(mode, 0o600, `Expected 0600 but got 0${mode.toString(8)}`);
  });

  it("removes a project", () => {
    saveProject("proj-rm", {
      anon_key: "ak", service_key: "sk", tier: "prototype",
      lease_expires_at: "2026-03-01T00:00:00Z",
    }, storePath);
    assert.ok(getProject("proj-rm", storePath));
    removeProject("proj-rm", storePath);
    assert.equal(getProject("proj-rm", storePath), undefined);
  });

  it("auto-migrates array format to object format", () => {
    writeFileSync(storePath, JSON.stringify([
      { project_id: "prj_a", anon_key: "ak1", service_key: "sk1", tier: "prototype", lease_expires_at: "2026-03-01T00:00:00Z" },
      { project_id: "prj_b", anon_key: "ak2", service_key: "sk2", tier: "hobby", lease_expires_at: "2026-04-01T00:00:00Z" },
    ]));
    const store = loadKeyStore(storePath);
    assert.ok(store.projects["prj_a"]);
    assert.equal(store.projects["prj_a"]!.anon_key, "ak1");
    assert.ok(store.projects["prj_b"]);
    assert.equal(store.projects["prj_b"]!.tier, "hobby");
  });

  it("auto-migrates expires_at to lease_expires_at", () => {
    writeFileSync(storePath, JSON.stringify({
      projects: {
        "prj_old": { anon_key: "ak", service_key: "sk", tier: "prototype", expires_at: "2026-03-01T00:00:00Z" },
      },
    }));
    const store = loadKeyStore(storePath);
    assert.equal(store.projects["prj_old"]!.lease_expires_at, "2026-03-01T00:00:00Z");
    assert.equal((store.projects["prj_old"] as Record<string, unknown>).expires_at, undefined);
  });

  it("auto-migrates array with expires_at field", () => {
    writeFileSync(storePath, JSON.stringify([
      { project_id: "prj_legacy", anon_key: "ak", service_key: "sk", tier: "prototype", expires_at: "2026-05-01T00:00:00Z" },
    ]));
    const store = loadKeyStore(storePath);
    assert.equal(store.projects["prj_legacy"]!.lease_expires_at, "2026-05-01T00:00:00Z");
  });

  it("preserves site_url and deployed_at in array migration", () => {
    writeFileSync(storePath, JSON.stringify([
      { project_id: "prj_site", anon_key: "ak", service_key: "sk", tier: "prototype", lease_expires_at: "2026-03-01T00:00:00Z", site_url: "https://test.sites.run402.com", deployed_at: "2026-03-01T00:00:00Z" },
    ]));
    const store = loadKeyStore(storePath);
    assert.equal(store.projects["prj_site"]!.site_url, "https://test.sites.run402.com");
    assert.equal(store.projects["prj_site"]!.deployed_at, "2026-03-01T00:00:00Z");
  });

  it("handles corrupt JSON gracefully", () => {
    writeFileSync(storePath, "NOT VALID JSON{{{", "utf-8");
    const store = loadKeyStore(storePath);
    assert.deepEqual(store, { projects: {} });
  });
});
