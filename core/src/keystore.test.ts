import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadKeyStore, saveKeyStore, getProject, saveProject, removeProject, getActiveProjectId, setActiveProjectId } from "./keystore.js";
import type { StoredProject, KeyStore } from "./keystore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    };
    saveProject("proj-001", project, storePath);
    const loaded = getProject("proj-001", storePath);
    assert.deepEqual(loaded, project);
  });

  it("creates file with 0600 permissions", { skip: process.platform === "win32" ? "POSIX file modes not enforced on Windows NTFS" : false }, () => {
    saveProject("proj-002", {
      anon_key: "ak", service_key: "sk",
    }, storePath);
    const stats = statSync(storePath);
    const mode = stats.mode & 0o777;
    assert.equal(mode, 0o600, `Expected 0600 but got 0${mode.toString(8)}`);
  });

  it("removes a project", () => {
    saveProject("proj-rm", {
      anon_key: "ak", service_key: "sk",
    }, storePath);
    assert.ok(getProject("proj-rm", storePath));
    removeProject("proj-rm", storePath);
    assert.equal(getProject("proj-rm", storePath), undefined);
  });

  it("removes active_project_id when deleting the active project", () => {
    saveProject("proj-active", { anon_key: "ak", service_key: "sk" }, storePath);
    setActiveProjectId("proj-active", storePath);
    assert.equal(getActiveProjectId(storePath), "proj-active");
    removeProject("proj-active", storePath);
    assert.equal(getActiveProjectId(storePath), undefined);
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
    // tier is stripped during migration
    assert.equal((store.projects["prj_b"] as Record<string, unknown>).tier, undefined);
  });

  it("strips legacy tier/lease_expires_at/expires_at from object format", () => {
    writeFileSync(storePath, JSON.stringify({
      projects: {
        "prj_old": { anon_key: "ak", service_key: "sk", tier: "prototype", expires_at: "2026-03-01T00:00:00Z", lease_expires_at: "2026-03-01T00:00:00Z" },
      },
    }));
    const store = loadKeyStore(storePath);
    const rec = store.projects["prj_old"] as Record<string, unknown>;
    assert.equal(rec.tier, undefined);
    assert.equal(rec.lease_expires_at, undefined);
    assert.equal(rec.expires_at, undefined);
    assert.equal(store.projects["prj_old"]!.anon_key, "ak");
  });

  it("auto-migrates array with legacy fields stripped", () => {
    writeFileSync(storePath, JSON.stringify([
      { project_id: "prj_legacy", anon_key: "ak", service_key: "sk", tier: "prototype", expires_at: "2026-05-01T00:00:00Z" },
    ]));
    const store = loadKeyStore(storePath);
    assert.equal(store.projects["prj_legacy"]!.anon_key, "ak");
    assert.equal((store.projects["prj_legacy"] as Record<string, unknown>).tier, undefined);
  });

  it("preserves site_url and deployed_at in array migration", () => {
    writeFileSync(storePath, JSON.stringify([
      { project_id: "prj_site", anon_key: "ak", service_key: "sk", tier: "prototype", lease_expires_at: "2026-03-01T00:00:00Z", site_url: "https://test.sites.run402.com", deployed_at: "2026-03-01T00:00:00Z" },
    ]));
    const store = loadKeyStore(storePath);
    assert.equal(store.projects["prj_site"]!.site_url, "https://test.sites.run402.com");
    assert.equal(store.projects["prj_site"]!.deployed_at, "2026-03-01T00:00:00Z");
  });

  it("preserves active_project_id from existing store", () => {
    writeFileSync(storePath, JSON.stringify({
      active_project_id: "prj_x",
      projects: { "prj_x": { anon_key: "ak", service_key: "sk" } },
    }));
    const store = loadKeyStore(storePath);
    assert.equal(store.active_project_id, "prj_x");
  });

  it("sets and gets active project id", () => {
    saveProject("prj_act", { anon_key: "ak", service_key: "sk" }, storePath);
    setActiveProjectId("prj_act", storePath);
    assert.equal(getActiveProjectId(storePath), "prj_act");
  });

  it("handles corrupt JSON gracefully", () => {
    writeFileSync(storePath, "NOT VALID JSON{{{", "utf-8");
    const store = loadKeyStore(storePath);
    assert.deepEqual(store, { projects: {} });
  });

  it("preserves all entries under concurrent saveProject calls (GH-208)", async () => {
    writeFileSync(storePath, JSON.stringify({ projects: {} }));
    const workerSrc = join(__dirname, "keystore.test.worker.ts");
    const ids = ["a", "b", "c", "d"];
    await Promise.all(
      ids.map(
        (id) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ["--import", "tsx", workerSrc, storePath, id],
              { stdio: ["ignore", "ignore", "pipe"] },
            );
            const errChunks: Buffer[] = [];
            child.stderr.on("data", (chunk) => errChunks.push(chunk));
            child.on("error", reject);
            child.on("exit", (code) => {
              if (code === 0) resolve();
              else reject(new Error(`worker ${id} exited ${code}: ${Buffer.concat(errChunks).toString()}`));
            });
          }),
      ),
    );
    const store = loadKeyStore(storePath);
    for (const id of ids) {
      assert.ok(store.projects[id], `project ${id} should be present after concurrent saves`);
      assert.equal(store.projects[id]!.anon_key, `ak-${id}`);
    }
  });

  it("setActiveProjectId stamps previous_active_project_id when overwriting a different active", () => {
    saveProject("prj_one", { anon_key: "a1", service_key: "s1" }, storePath);
    saveProject("prj_two", { anon_key: "a2", service_key: "s2" }, storePath);
    setActiveProjectId("prj_one", storePath);
    setActiveProjectId("prj_two", storePath);
    const raw = JSON.parse(readFileSync(storePath, "utf-8"));
    assert.equal(raw.active_project_id, "prj_two");
    assert.equal(raw.previous_active_project_id, "prj_one");
  });

  it("setActiveProjectId does not stamp previous when active was unset", () => {
    saveProject("prj_one", { anon_key: "a1", service_key: "s1" }, storePath);
    setActiveProjectId("prj_one", storePath);
    const raw = JSON.parse(readFileSync(storePath, "utf-8"));
    assert.equal(raw.active_project_id, "prj_one");
    assert.equal(raw.previous_active_project_id, undefined);
  });

  it("setActiveProjectId does not stamp previous when re-setting same active", () => {
    saveProject("prj_one", { anon_key: "a1", service_key: "s1" }, storePath);
    setActiveProjectId("prj_one", storePath);
    setActiveProjectId("prj_one", storePath);
    const raw = JSON.parse(readFileSync(storePath, "utf-8"));
    assert.equal(raw.active_project_id, "prj_one");
    assert.equal(raw.previous_active_project_id, undefined);
  });

  it("removeProject(activeId) falls back to previous_active_project_id when prior project still exists (GH-183)", () => {
    saveProject("prj_one", { anon_key: "a1", service_key: "s1" }, storePath);
    setActiveProjectId("prj_one", storePath);
    saveProject("prj_two", { anon_key: "a2", service_key: "s2" }, storePath);
    setActiveProjectId("prj_two", storePath);

    removeProject("prj_two", storePath);

    assert.equal(getActiveProjectId(storePath), "prj_one");
    const raw = JSON.parse(readFileSync(storePath, "utf-8"));
    assert.equal(raw.previous_active_project_id, undefined);
  });

  it("removeProject(activeId) clears both pointers when prior project is gone (GH-183)", () => {
    saveProject("prj_one", { anon_key: "a1", service_key: "s1" }, storePath);
    setActiveProjectId("prj_one", storePath);
    saveProject("prj_two", { anon_key: "a2", service_key: "s2" }, storePath);
    setActiveProjectId("prj_two", storePath);

    removeProject("prj_one", storePath);
    removeProject("prj_two", storePath);

    assert.equal(getActiveProjectId(storePath), undefined);
    const raw = JSON.parse(readFileSync(storePath, "utf-8"));
    assert.equal(raw.active_project_id, undefined);
    assert.equal(raw.previous_active_project_id, undefined);
  });

  it("removeProject of non-active project leaves previous_active_project_id untouched", () => {
    saveProject("prj_one", { anon_key: "a1", service_key: "s1" }, storePath);
    setActiveProjectId("prj_one", storePath);
    saveProject("prj_two", { anon_key: "a2", service_key: "s2" }, storePath);
    setActiveProjectId("prj_two", storePath);
    saveProject("prj_three", { anon_key: "a3", service_key: "s3" }, storePath);

    removeProject("prj_three", storePath);

    const raw = JSON.parse(readFileSync(storePath, "utf-8"));
    assert.equal(raw.active_project_id, "prj_two");
    assert.equal(raw.previous_active_project_id, "prj_one");
  });
});
