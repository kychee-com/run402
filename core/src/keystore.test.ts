import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadKeyStore, saveKeyStore, getProject, saveProject, removeProject, getActiveProjectId, setActiveProjectId, clearActiveProjectId } from "./keystore.js";
import type { StoredProject, KeyStore } from "./keystore.js";
import { saveAllowance } from "./allowance.js";
import { setActiveProjectId as setProfileActiveProjectId, clearActiveProjectId as clearProfileActiveProjectId } from "./profile-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let tempDir: string;
let storePath: string;
let statePath: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  originalConfigDir = process.env.RUN402_CONFIG_DIR;
  tempDir = mkdtempSync(join(tmpdir(), "run402-core-keystore-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  storePath = join(tempDir, "project-keys.v1.json");
  statePath = join(tempDir, "state.json");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.RUN402_CONFIG_DIR;
  else process.env.RUN402_CONFIG_DIR = originalConfigDir;
});

describe("core keystore", () => {
  it("returns empty store when file does not exist", () => {
    const store = loadKeyStore(storePath);
    assert.deepEqual(store, { version: 1, source: "local_cache", projects: {} });
  });

  it("saves and loads a project", () => {
    const project: StoredProject = {
      anon_key: "anon-key-123",
      service_key: "svc-key-456",
    };
    saveProject("proj-001", project, storePath);
    const loaded = getProject("proj-001", storePath);
    assert.equal(loaded?.anon_key, project.anon_key);
    assert.equal(loaded?.service_key, project.service_key);
    assert.equal(typeof loaded?.cached_at, "string");
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

  it("removes active_project_id when deleting the active project through default paths", () => {
    saveProject("proj-active", { anon_key: "ak", service_key: "sk" });
    setActiveProjectId("proj-active");
    assert.equal(getActiveProjectId(), "proj-active");
    removeProject("proj-active");
    assert.equal(getActiveProjectId(), undefined);
  });

  it("does not clear active state when removing an explicit credential-cache path", () => {
    saveProject("proj-active", { anon_key: "ak", service_key: "sk" }, storePath);
    setActiveProjectId("proj-active", statePath);
    removeProject("proj-active", storePath);
    assert.equal(getActiveProjectId(statePath), "proj-active");
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
    setActiveProjectId("prj_act", statePath);
    assert.equal(getActiveProjectId(statePath), "prj_act");
  });

  describe("active project id is scoped by the current wallet's principal (kychee-com/run402#559a)", () => {
    // `setActiveProjectId`/`getActiveProjectId` here must scope by the SAME
    // principal `NodeCredentialsProvider.setActiveProject`
    // (sdk/src/node/credentials.ts) uses — the CURRENT wallet's allowance
    // address — or a pre-existing principal-LESS ("unknown"-bucket) write
    // permanently shadows every later wallet-scoped one for every reader in
    // this module (resolveProjectId, `projects current`, gitvault target
    // resolution, ...). Default (no explicit `path`) so `getAllowancePath()`
    // resolves from the same `RUN402_CONFIG_DIR` these tests already set.

    // Built, not hand-typed: `readAllowance`'s ADDRESS_RE demands EXACTLY 40
    // hex chars, and a hand-counted literal one or two short still LOOKS
    // plausible while silently failing validation — which would make every
    // test below exercise the malformed-address fallback (principal: null,
    // the "unknown" bucket) instead of the real wallet-scoping it claims to
    // test, and still pass, for the wrong reason.
    const ADDR_A = `0x${"1".repeat(40)}`;
    const ADDR_B = `0x${"2".repeat(40)}`;
    const ADDR_C = `0x${"3".repeat(40)}`;
    const ADDR_D = `0x${"4".repeat(40)}`;

    it("a wallet-scoped set is visible to a wallet-scoped get, distinct from an unscoped ('unknown'-principal) entry", () => {
      // Simulate a pre-existing principal-less write — exactly what the
      // one-time legacy projects.json migration (or any no-wallet
      // provision/`use`) leaves behind — poisoning the "unknown" bucket with
      // a DIFFERENT, stale project.
      setProfileActiveProjectId("prj_B_stale", undefined, {});

      saveAllowance({
        address: ADDR_A,
        privateKey: "0x" + "a".repeat(64),
        created: new Date().toISOString(),
        funded: false,
      });

      setActiveProjectId("prj_A_fresh");
      assert.equal(
        getActiveProjectId(),
        "prj_A_fresh",
        "a wallet-scoped read must see the wallet-scoped write, not a pre-existing unscoped entry",
      );
    });

    it("switching wallets (different allowance address) resolves the flat fallback, never a DIFFERENT wallet's stale scoped entry", () => {
      saveAllowance({
        address: ADDR_B,
        privateKey: "0x" + "b".repeat(64),
        created: new Date().toISOString(),
        funded: false,
      });
      setActiveProjectId("prj_wallet_two");

      saveAllowance({
        address: ADDR_C,
        privateKey: "0x" + "c".repeat(64),
        created: new Date().toISOString(),
        funded: false,
      });
      // No scoped entry for THIS principal yet — falls to the flat value,
      // which is the most-recently-set project regardless of which wallet
      // set it (the flat fallback is intentionally wallet-agnostic).
      assert.equal(getActiveProjectId(), "prj_wallet_two");
    });

    it("unparseable allowance JSON degrades to the unscoped bucket rather than throwing", () => {
      writeFileSync(join(tempDir, "allowance.json"), "NOT VALID JSON{{{", "utf-8");
      // Must not throw — the malformed allowance is a wallet-validity concern
      // for other code paths, not a reason to fail active-project resolution.
      setActiveProjectId("prj_no_wallet");
      assert.equal(getActiveProjectId(), "prj_no_wallet");
    });

    it("valid-JSON-but-wrong-shape allowance (readAllowance's own throw, GH-194) also degrades rather than propagating", () => {
      writeFileSync(join(tempDir, "allowance.json"), JSON.stringify({ notAnAddress: true }), "utf-8");
      setActiveProjectId("prj_bad_shape");
      assert.equal(getActiveProjectId(), "prj_bad_shape");
    });

    it("keystore.js's clearActiveProjectId clears the WALLET-scoped entry, unlike profile-state.js's unscoped one (cli-e2e.test.mjs GH-40 regression)", () => {
      saveAllowance({
        address: ADDR_D,
        privateKey: "0x" + "d".repeat(64),
        created: new Date().toISOString(),
        funded: false,
      });
      setActiveProjectId("prj_clear_me");
      assert.equal(getActiveProjectId(), "prj_clear_me");

      // The unscoped clear (what a caller reaching past keystore.js into
      // profile-state.js directly would do) only clears the "unknown"
      // bucket — the wallet-scoped entry this test's own `setActiveProjectId`
      // call above wrote survives it untouched.
      clearProfileActiveProjectId("prj_clear_me");
      assert.equal(getActiveProjectId(), "prj_clear_me", "the unscoped clear must NOT have touched the wallet-scoped entry");

      clearActiveProjectId("prj_clear_me");
      assert.equal(getActiveProjectId(), undefined, "the correctly-scoped clear removes it");
    });
  });

  it("handles corrupt JSON gracefully", () => {
    writeFileSync(storePath, "NOT VALID JSON{{{", "utf-8");
    const store = loadKeyStore(storePath);
    assert.deepEqual(store, { version: 1, source: "local_cache", projects: {} });
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
    setActiveProjectId("prj_one", statePath);
    setActiveProjectId("prj_two", statePath);
    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(raw.active_project_id, "prj_two");
    assert.equal(raw.previous_active_project_id, "prj_one");
  });

  it("setActiveProjectId does not stamp previous when active was unset", () => {
    saveProject("prj_one", { anon_key: "a1", service_key: "s1" }, storePath);
    setActiveProjectId("prj_one", statePath);
    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(raw.active_project_id, "prj_one");
    assert.equal(raw.previous_active_project_id, undefined);
  });

  it("setActiveProjectId does not stamp previous when re-setting same active", () => {
    saveProject("prj_one", { anon_key: "a1", service_key: "s1" }, storePath);
    setActiveProjectId("prj_one", statePath);
    setActiveProjectId("prj_one", statePath);
    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(raw.active_project_id, "prj_one");
    assert.equal(raw.previous_active_project_id, undefined);
  });

  it("removeProject(activeId) falls back to previous_active_project_id when prior project still exists (GH-183)", () => {
    saveProject("prj_one", { anon_key: "a1", service_key: "s1" });
    setActiveProjectId("prj_one");
    saveProject("prj_two", { anon_key: "a2", service_key: "s2" });
    setActiveProjectId("prj_two");

    removeProject("prj_two");

    assert.equal(getActiveProjectId(), "prj_one");
    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(raw.previous_active_project_id, undefined);
  });

  it("removeProject(activeId) falls back to previous active id without consulting credential cache", () => {
    saveProject("prj_one", { anon_key: "a1", service_key: "s1" });
    setActiveProjectId("prj_one");
    saveProject("prj_two", { anon_key: "a2", service_key: "s2" });
    setActiveProjectId("prj_two");

    removeProject("prj_one");
    removeProject("prj_two");

    assert.equal(getActiveProjectId(), "prj_one");
    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(raw.active_project_id, "prj_one");
    assert.equal(raw.previous_active_project_id, undefined);
  });

  it("removeProject of non-active project leaves previous_active_project_id untouched", () => {
    saveProject("prj_one", { anon_key: "a1", service_key: "s1" }, storePath);
    setActiveProjectId("prj_one", statePath);
    saveProject("prj_two", { anon_key: "a2", service_key: "s2" }, storePath);
    setActiveProjectId("prj_two", statePath);
    saveProject("prj_three", { anon_key: "a3", service_key: "s3" }, storePath);

    removeProject("prj_three", storePath);

    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(raw.active_project_id, "prj_two");
    assert.equal(raw.previous_active_project_id, "prj_one");
  });
});
