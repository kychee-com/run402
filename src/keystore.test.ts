import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadKeyStore, saveKeyStore, getProject, saveProject } from "./keystore.js";
import type { StoredProject, KeyStore } from "./keystore.js";

let tempDir: string;
let storePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-keystore-test-"));
  storePath = join(tempDir, "projects.json");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("keystore", () => {
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
    const project: StoredProject = {
      anon_key: "ak",
      service_key: "sk",
      tier: "hobby",
      lease_expires_at: "2026-04-01T00:00:00Z",
    };
    saveProject("proj-002", project, storePath);

    const stats = statSync(storePath);
    const mode = stats.mode & 0o777;
    assert.equal(mode, 0o600, `Expected 0600 but got 0${mode.toString(8)}`);
  });

  it("stores multiple projects independently", () => {
    const p1: StoredProject = {
      anon_key: "ak1",
      service_key: "sk1",
      tier: "prototype",
      lease_expires_at: "2026-03-01T00:00:00Z",
    };
    const p2: StoredProject = {
      anon_key: "ak2",
      service_key: "sk2",
      tier: "team",
      lease_expires_at: "2026-04-01T00:00:00Z",
    };

    saveProject("proj-a", p1, storePath);
    saveProject("proj-b", p2, storePath);

    assert.deepEqual(getProject("proj-a", storePath), p1);
    assert.deepEqual(getProject("proj-b", storePath), p2);
  });

  it("returns undefined for non-existent project", () => {
    assert.equal(getProject("no-such-project", storePath), undefined);
  });

  it("overwrites existing project entry", () => {
    const v1: StoredProject = {
      anon_key: "old",
      service_key: "old",
      tier: "prototype",
      lease_expires_at: "2026-03-01T00:00:00Z",
    };
    const v2: StoredProject = {
      anon_key: "new",
      service_key: "new",
      tier: "hobby",
      lease_expires_at: "2026-04-01T00:00:00Z",
    };

    saveProject("proj-x", v1, storePath);
    saveProject("proj-x", v2, storePath);

    assert.deepEqual(getProject("proj-x", storePath), v2);
  });

  it("handles corrupt JSON gracefully", () => {
    writeFileSync(storePath, "NOT VALID JSON{{{", "utf-8");
    const store = loadKeyStore(storePath);
    assert.deepEqual(store, { projects: {} });
  });

  it("handles file with missing projects key", () => {
    writeFileSync(storePath, '{"version": 1}', "utf-8");
    const store = loadKeyStore(storePath);
    assert.deepEqual(store, { projects: {} });
  });

  it("atomic write survives — file is valid JSON after save", () => {
    const project: StoredProject = {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      lease_expires_at: "2026-03-01T00:00:00Z",
    };
    saveProject("proj-atomic", project, storePath);

    // Verify the file is valid JSON
    const raw = readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(raw) as KeyStore;
    assert.deepEqual(parsed.projects["proj-atomic"], project);
  });
});
