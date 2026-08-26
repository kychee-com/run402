import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compareSemver,
  createUpdateCheckScheduler,
  detectInstallContext,
  doctorUpdateCheck,
  emitUpdateNotice,
  isCacheFresh,
  readUpdateCache,
  refreshUpdateCheck,
  updateNoticeFromRecord,
  upgradeNextActions,
  writeUpdateCache,
} from "./update-check.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "run402-update-check-"));
}

async function withTemp(fn) {
  const dir = tempDir();
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function packageJson(dir, body) {
  writeFileSync(join(dir, "package.json"), JSON.stringify(body, null, 2));
}

function staleRecord(latest = "3.7.15") {
  return {
    current: "3.7.14",
    latest,
    checked_at: "2026-07-03T10:18:20.000Z",
    source: "cache",
    error: null,
  };
}

describe("CLI update check semver and cache", () => {
  it("compares normal, prerelease, current-newer, and invalid semver safely", () => {
    assert.equal(compareSemver("3.7.14", "3.7.15"), -1);
    assert.equal(compareSemver("3.7.15", "3.7.14"), 1);
    assert.equal(compareSemver("3.7.15-beta.1", "3.7.15"), -1);
    assert.equal(compareSemver("3.7.15", "3.7.15-beta.1"), 1);
    assert.equal(compareSemver("not-semver", "3.7.15"), null);
  });

  it("treats corrupt cache as absent and unwritable cache as fail-open", () => withTemp((dir) => {
    const cachePath = join(dir, "cache.json");
    writeFileSync(cachePath, "{");
    assert.equal(readUpdateCache({ path: cachePath }), null);

    mkdirSync(join(dir, "as-directory"));
    assert.equal(writeUpdateCache(staleRecord(), { path: join(dir, "as-directory") }), false);
  }));

  it("tracks cache TTL from checked_at", () => {
    const checked_at = "2026-07-03T10:00:00.000Z";
    assert.equal(isCacheFresh({ checked_at }, { now: Date.parse("2026-07-03T11:00:00.000Z") }), true);
    assert.equal(isCacheFresh({ checked_at }, { now: Date.parse("2026-07-05T11:00:00.000Z") }), false);
  });

  it("records timeout and malformed latest checks as non-throwing failure cache", async () => withTemp(async (dir) => {
    const timeout = await refreshUpdateCheck({
      current: "3.7.14",
      cachePath: join(dir, "timeout.json"),
      timeoutMs: 1,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
    });
    assert.equal(timeout.ok, false);
    assert.equal(timeout.error.code, "TIMEOUT");

    const malformed = await refreshUpdateCheck({
      current: "3.7.14",
      cachePath: join(dir, "malformed.json"),
      fetchImpl: async () => new Response(JSON.stringify({ version: "latest" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error.code, "INVALID_LATEST");
  }));

  it("uses custom npm registries and fails open when they are unavailable", async () => withTemp(async (dir) => {
    let requested = "";
    const result = await refreshUpdateCheck({
      current: "3.7.14",
      cachePath: join(dir, "custom-registry.json"),
      env: { RUN402_NPM_REGISTRY: "https://registry.example.test/npm/" },
      fetchImpl: async (url) => {
        requested = String(url);
        return new Response(JSON.stringify({ error: "down" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "NETWORK_ERROR");
    assert.equal(requested, "https://registry.example.test/npm/run402/latest");
    assert.ok(readUpdateCache({ path: join(dir, "custom-registry.json") }));
  }));
});

describe("CLI install-context detection", () => {
  it("detects stale project-local npm installs and suggests a local mutation", () => withTemp((dir) => {
    packageJson(dir, { devDependencies: { run402: "3.7.14" } });
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    const install = detectInstallContext({
      cwd: dir,
      execPath: join(dir, "node_modules", ".bin", "run402"),
      env: { npm_config_user_agent: "npm/11.0.0 node/v22" },
    });
    assert.equal(install.kind, "local_project");
    assert.equal(install.confidence, "high");
    const [action] = upgradeNextActions({ install, cwd: dir });
    assert.deepEqual(action.argv, ["npm", "install", "-D", "run402@latest"]);
    assert.equal(action.mutates_project, true);
    assert.equal(action.mutates_global_install, false);
  }));

  it("detects global npm installs and avoids mutating the project", () => withTemp((dir) => {
    packageJson(dir, { devDependencies: { run402: "3.7.14" } });
    const install = detectInstallContext({
      cwd: dir,
      execPath: "/usr/local/lib/node_modules/run402/cli.mjs",
      env: { npm_config_prefix: "/usr/local" },
    });
    assert.equal(install.kind, "global_npm");
    const [action] = upgradeNextActions({ install, cwd: dir });
    assert.deepEqual(action.argv, ["npm", "install", "-g", "run402@latest"]);
    assert.equal(action.mutates_project, false);
    assert.equal(action.mutates_global_install, true);
  }));

  it("detects npx/npm exec and suggests an ephemeral latest rerun", () => withTemp((dir) => {
    const install = detectInstallContext({
      cwd: dir,
      execPath: join(dir, ".npm", "_npx", "abc", "node_modules", "run402", "cli.mjs"),
      argv: ["node", "run402", "up", "--json"],
      env: { npm_command: "exec", npm_config_user_agent: "npm/11 node/v22" },
    });
    assert.equal(install.kind, "ephemeral_exec");
    const [action] = upgradeNextActions({ install, cwd: dir, command: ["run402", "up", "--json"] });
    assert.deepEqual(action.argv, ["npx", "-y", "run402@latest", "up", "--json"]);
    assert.equal(action.mutates_project, false);
  }));

  it("handles pnpm symlink layouts, Yarn PnP, Bun local/bunx, and Windows shims", () => withTemp((dir) => {
    packageJson(dir, { packageManager: "pnpm@10.0.0", devDependencies: { run402: "3.7.14" } });
    let install = detectInstallContext({
      cwd: dir,
      execPath: join(dir, "node_modules", ".pnpm", "run402@3.7.14", "node_modules", "run402", "cli.mjs"),
      env: {},
    });
    assert.equal(install.kind, "local_project");
    assert.equal(upgradeNextActions({ install })[0].argv[0], "pnpm");

    packageJson(dir, { packageManager: "yarn@4.0.0", devDependencies: { run402: "3.7.14" } });
    install = detectInstallContext({
      cwd: dir,
      execPath: join(dir, ".yarn", "cache", "run402.zip", "node_modules", "run402", "cli.mjs"),
      env: { NODE_OPTIONS: "--require ./.pnp.cjs" },
    });
    assert.equal(install.kind, "local_project");
    assert.equal(install.package_manager, "yarn");

    packageJson(dir, { packageManager: "bun@1.2.0", devDependencies: { run402: "3.7.14" } });
    install = detectInstallContext({
      cwd: dir,
      execPath: join(dir, "node_modules", ".bin", "run402"),
      env: { npm_config_user_agent: "bun/1.2.0" },
    });
    assert.equal(install.kind, "local_project");
    assert.equal(upgradeNextActions({ install })[0].argv[0], "bun");

    install = detectInstallContext({
      cwd: dir,
      execPath: "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\run402\\cli.mjs",
      argv: ["node", "run402"],
      env: { npm_config_npx: "true" },
      platform: "win32",
    });
    assert.equal(install.kind, "ephemeral_exec");
  }));

  it("detects workspace-root local installs from package subdirectories", () => withTemp((dir) => {
    packageJson(dir, {
      packageManager: "pnpm@10.0.0",
      workspaces: ["packages/*"],
      devDependencies: { run402: "3.7.14" },
    });
    const appDir = join(dir, "packages", "app");
    mkdirSync(appDir, { recursive: true });
    packageJson(appDir, { name: "app", private: true });
    const install = detectInstallContext({
      cwd: appDir,
      execPath: join(dir, "node_modules", ".bin", "run402"),
      env: {},
    });
    assert.equal(install.kind, "local_project");
    assert.equal(install.cwd, dir);
    assert.equal(install.package_root, dir);
    const [action] = upgradeNextActions({ install, cwd: appDir });
    assert.deepEqual(action.argv, ["pnpm", "add", "-D", "run402@latest"]);
    assert.equal(action.cwd, dir);
    assert.equal(action.mutates_project, true);
  }));

  it("treats package-declared shims and pnpm exec as local project installs", () => withTemp((dir) => {
    packageJson(dir, { packageManager: "npm@11.0.0", devDependencies: { run402: "3.7.14" } });
    let install = detectInstallContext({
      cwd: dir,
      execPath: "node_modules/.bin/run402",
      env: {},
    });
    assert.equal(install.kind, "local_project");
    assert.equal(install.package_manager, "npm");
    assert.deepEqual(upgradeNextActions({ install })[0].argv, ["npm", "install", "-D", "run402@latest"]);

    packageJson(dir, { packageManager: "pnpm@10.0.0", devDependencies: { run402: "3.7.14" } });
    install = detectInstallContext({
      cwd: dir,
      execPath: "/opt/pnpm/run402",
      env: { npm_command: "exec", npm_config_user_agent: "pnpm/10.0.0 npm/? node/v22" },
    });
    assert.equal(install.kind, "local_project");
    assert.equal(install.package_manager, "pnpm");
    assert.deepEqual(upgradeNextActions({ install })[0].argv, ["pnpm", "add", "-D", "run402@latest"]);
  }));

  it("uses packageManager over conflicting lockfiles and gives custom paths low-confidence doctor guidance", () => withTemp((dir) => {
    packageJson(dir, { packageManager: "pnpm@10.0.0" });
    writeFileSync(join(dir, "package-lock.json"), "{}");
    writeFileSync(join(dir, "yarn.lock"), "");
    const install = detectInstallContext({
      cwd: dir,
      execPath: join(dir, "dist", "run402-dev.mjs"),
      env: {},
    });
    assert.equal(install.kind, "custom_path");
    assert.equal(install.package_manager, "pnpm");
    const [action] = upgradeNextActions({ install, cwd: dir });
    assert.deepEqual(action.argv, ["run402", "doctor", "--refresh"]);
    assert.equal(action.confidence, "low");
  }));

  it("keeps nvm/asdf global installs separate from Volta/Corepack-style ambiguous shims", () => withTemp((dir) => {
    let install = detectInstallContext({
      cwd: dir,
      execPath: "/Users/me/.volta/tools/image/packages/run402/bin/run402",
      env: {},
    });
    assert.equal(install.kind, "package_manager_shim");
    assert.equal(install.confidence, "low");
    assert.deepEqual(upgradeNextActions({ install })[0].argv, ["run402", "doctor", "--refresh"]);

    install = detectInstallContext({
      cwd: dir,
      execPath: "/Users/me/.nvm/versions/node/v24.0.0/lib/node_modules/run402/cli.mjs",
      env: {},
    });
    assert.equal(install.kind, "global_npm");
    assert.deepEqual(upgradeNextActions({ install })[0].argv, ["npm", "install", "-g", "run402@latest"]);

    install = detectInstallContext({
      cwd: dir,
      execPath: "/Users/me/.asdf/installs/nodejs/24.0.0/lib/node_modules/run402/cli.mjs",
      env: {},
    });
    assert.equal(install.kind, "global_npm");

    install = detectInstallContext({
      cwd: dir,
      execPath: "/Users/me/.cache/corepack/run402",
      env: { npm_config_user_agent: "yarn/4.0.0 node/v24" },
    });
    assert.equal(install.kind, "custom_path");
    assert.equal(install.confidence, "low");
    assert.equal(upgradeNextActions({ install })[0].mutates_project, false);
  }));

  it("distinguishes stale local shadowing from explicit latest npx reruns", () => withTemp((dir) => {
    packageJson(dir, { devDependencies: { run402: "3.7.14" } });
    let install = detectInstallContext({
      cwd: dir,
      execPath: join(dir, ".npm", "_npx", "shadow", "node_modules", "run402", "cli.mjs"),
      argv: ["npx", "run402", "up"],
      env: { npm_config_npx: "true" },
    });
    assert.equal(install.kind, "ephemeral_exec");
    assert.deepEqual(
      upgradeNextActions({ install, cwd: dir, command: ["run402", "up"] })[0].argv,
      ["npx", "-y", "run402@latest", "up"],
    );

    install = detectInstallContext({
      cwd: dir,
      execPath: join(dir, ".npm", "_npx", "latest", "node_modules", "run402", "cli.mjs"),
      argv: ["npx", "-y", "run402@latest", "up"],
      env: { npm_command: "exec" },
    });
    assert.equal(install.kind, "ephemeral_exec");
    assert.deepEqual(
      upgradeNextActions({ install, cwd: dir, command: ["run402", "up"] })[0].argv,
      ["npx", "-y", "run402@latest", "up"],
    );
  }));
});

describe("CLI update notices and scheduler", () => {
  it("builds structured stale notices with argv/cwd/confidence/mutation flags", () => withTemp((dir) => {
    packageJson(dir, { devDependencies: { run402: "3.7.14" } });
    const notice = updateNoticeFromRecord(staleRecord(), {
      cwd: dir,
      execPath: join(dir, "node_modules", ".bin", "run402"),
      current: "3.7.14",
      command: ["run402", "up", "--json"],
    });
    assert.equal(notice.type, "cli.update_available");
    assert.equal(notice.source, "cache");
    assert.equal(notice.install_context, "local_project");
    assert.deepEqual(notice.next_actions[0].argv, ["npm", "install", "-D", "run402@latest"]);
    assert.equal(notice.next_actions[0].cwd, dir);
    assert.equal(notice.next_actions[0].confidence, "high");
    assert.equal(notice.next_actions[0].mutates_project, true);
  }));

  it("does not emit for invalid latest, prerelease newer current, current newer, or opt-out", () => withTemp((dir) => {
    assert.equal(updateNoticeFromRecord(staleRecord("wat"), { cwd: dir, current: "3.7.14" }), null);
    assert.equal(updateNoticeFromRecord(staleRecord("3.7.15-beta.1"), { cwd: dir, current: "3.7.15" }), null);
    assert.equal(updateNoticeFromRecord(staleRecord("3.7.14"), { cwd: dir, current: "3.7.15" }), null);
    assert.equal(updateNoticeFromRecord(staleRecord("3.7.15"), {
      cwd: dir,
      current: "3.7.14",
      env: { RUN402_NO_UPDATE_CHECK: "1" },
    }), null);
  }));

  it("keeps notices off success stdout except json-stream structured events", () => {
    const notice = { type: "cli.update_available", schema_version: 1 };
    const stdout = [];
    const stderr = [];
    assert.equal(emitUpdateNotice(notice, {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    }), true);
    assert.deepEqual(stdout, []);
    assert.equal(JSON.parse(stderr[0]).type, "cli.update_available");

    stdout.length = 0;
    stderr.length = 0;
    emitUpdateNotice(notice, {
      jsonStream: true,
      quiet: true,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    assert.equal(JSON.parse(stdout[0]).type, "cli.update_available");
    assert.deepEqual(stderr, []);
  });

  it("normal commands use cache immediately, skip live checks in CI/non-TTY, and honor explicit opt-in", async () => withTemp(async (dir) => {
    const cachePath = join(dir, "cache.json");
    writeUpdateCache(staleRecord(), { path: cachePath });
    let fetchCalls = 0;
    let scheduler = createUpdateCheckScheduler({
      cwd: dir,
      cachePath,
      current: "3.7.14",
      env: { CI: "true" },
      stderrIsTTY: false,
      stdoutIsTTY: false,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ version: "3.7.16" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(scheduler.cachedNotice.type, "cli.update_available");
    assert.equal(scheduler.livePromise, null);
    assert.equal(fetchCalls, 0);

    chmodSync(cachePath, 0o600);
    scheduler = createUpdateCheckScheduler({
      cwd: dir,
      cachePath,
      current: "3.7.14",
      env: { CI: "true", RUN402_UPDATE_CHECK: "1" },
      stderrIsTTY: false,
      stdoutIsTTY: false,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ version: "3.7.16" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      now: Date.parse("2026-07-05T10:18:20.000Z"),
    });
    assert.ok(scheduler.livePromise);
    await scheduler.livePromise;
    assert.equal(fetchCalls, 1);
    assert.equal(scheduler.getCompletedLiveNotice().latest, "3.7.16");
  }));

  it("doctor reports a cached warning and skipped state without failing other checks", async () => withTemp(async (dir) => {
    packageJson(dir, { devDependencies: { run402: "3.7.14" } });
    const cachePath = join(dir, "cache.json");
    const now = Date.parse("2026-07-03T10:30:00.000Z"); // 12min after staleRecord()'s checked_at — inside the 24h TTL
    // Fixed `now` so this stays a within-TTL read: no live check, no
    // fetchImpl needed at all for this half of the test.
    writeUpdateCache(staleRecord(), { path: cachePath });
    let check = await doctorUpdateCheck({
      cwd: dir,
      execPath: join(dir, "node_modules", ".bin", "run402"),
      current: "3.7.14",
      cachePath,
      now,
    });
    assert.equal(check.status, "warning");
    assert.equal(check.value.next_actions[0].mutates_project, true);

    check = await doctorUpdateCheck({
      cwd: dir,
      current: "3.7.14",
      cachePath,
      env: { RUN402_NO_UPDATE_CHECK: "1" },
      fetchImpl: async () => { throw new Error("RUN402_NO_UPDATE_CHECK must skip every network attempt"); },
    });
    assert.equal(check.status, "skipped");
  }));

  // ─── the real TTL, and what happens at every edge of it (kychee-com/run402#561) ──
  //
  // THE DEFECT (grok dogfood, 4.38.0 installed): `run402 doctor` reported
  // the latest CLI as 4.17.5 from a cache dated Aug 1 — three minor versions
  // and ~4 weeks stale — because NOTHING besides an explicit `--refresh`
  // ever re-checked it. `UPDATE_CHECK_TTL_MS` was already 24h; the bug was
  // that a plain `doctor` invocation never consulted it to trigger a
  // refresh, only to LABEL the cache `fresh: false` in a field nobody read.
  // Four states, each hermetic (`fetchImpl` is always injected — no real
  // npm registry call from this file, ever):
  describe("doctor's cache TTL actually causes a refresh (kychee-com/run402#561)", () => {
    it("fresh fetch: no cache at all triggers ONE automatic live check, even without --refresh", () => withTemp(async (dir) => {
      const cachePath = join(dir, "cache.json");
      let fetchCalls = 0;
      const check = await doctorUpdateCheck({
        cwd: dir,
        current: "3.7.14",
        cachePath,
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ version: "3.7.16" }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });
      assert.equal(fetchCalls, 1, "no cache existed yet — a live check must run automatically, not just on --refresh");
      assert.equal(check.status, "warning");
      assert.equal(check.value.latest, "3.7.16");
      assert.equal(check.value.cache.fresh, true);
      assert.equal(check.value.cache.refresh_attempted, true);
      assert.equal(check.value.cache.refresh_failed, false);
      assert.ok(readUpdateCache({ path: cachePath }), "the fresh result must be persisted for the next call");
    }));

    it("within-TTL reuse: a cache inside the 24h window is served as-is, with NO live check at all", () => withTemp(async (dir) => {
      const cachePath = join(dir, "cache.json");
      const now = Date.parse("2026-08-01T12:00:00.000Z");
      writeUpdateCache({
        current: "3.7.14",
        latest: "3.7.15",
        checked_at: new Date(now - 60 * 60 * 1000).toISOString(), // 1h old
        source: "cache",
        error: null,
      }, { path: cachePath });
      let fetchCalls = 0;
      const check = await doctorUpdateCheck({
        cwd: dir,
        current: "3.7.14",
        cachePath,
        now,
        fetchImpl: async () => { fetchCalls += 1; throw new Error("a fresh cache must never trigger a live check"); },
      });
      assert.equal(fetchCalls, 0);
      assert.equal(check.status, "warning");
      assert.equal(check.value.latest, "3.7.15");
      assert.equal(check.value.cache.fresh, true);
      assert.equal(check.value.cache.refresh_attempted, false);
      assert.equal(check.value.cache.age_ms, 60 * 60 * 1000);
    }));

    it("expired-refresh: a cache past the 24h TTL is refreshed automatically, and the FRESH value wins", () => withTemp(async (dir) => {
      const cachePath = join(dir, "cache.json");
      // Real wall-clock throughout (no fixed `now`): a SUCCESSFUL live check
      // stamps `checked_at` with the actual current time internally
      // (`refreshUpdateCheck` has no clock override), so comparing it
      // against a fixed test `now` from the past would read as stale by
      // construction — the "30 days old" fixture only needs to predate the
      // REAL clock, which `Date.now() - 30d` does unconditionally.
      writeUpdateCache({
        current: "3.7.14",
        latest: "3.7.15",
        checked_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days old
        source: "cache",
        error: null,
      }, { path: cachePath });
      let fetchCalls = 0;
      const check = await doctorUpdateCheck({
        cwd: dir,
        current: "3.7.14",
        cachePath,
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ version: "3.7.20" }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });
      assert.equal(fetchCalls, 1, "an expired cache must trigger exactly one automatic live check");
      assert.equal(check.value.latest, "3.7.20", "the fresh value wins, not the 30-day-old one");
      assert.equal(check.value.cache.fresh, true);
      assert.equal(check.value.cache.refresh_failed, false);
    }));

    it("offline-stale-labeled: an expired cache whose live refresh FAILS falls back to the last known-good value, clearly labeled with its age", () => withTemp(async (dir) => {
      const cachePath = join(dir, "cache.json");
      const now = Date.parse("2026-08-26T12:00:00.000Z"); // grok's own dogfood date
      writeUpdateCache({
        current: "3.7.14",
        latest: "4.17.5", // the exact stale value grok saw
        checked_at: "2026-08-01T10:18:20.000Z", // ~25 days old
        source: "cache",
        error: null,
      }, { path: cachePath });
      const check = await doctorUpdateCheck({
        cwd: dir,
        current: "3.7.14",
        cachePath,
        now,
        fetchImpl: async () => { throw new Error("offline"); },
      });
      // Faithful: the network is down, but the LAST KNOWN value is not thrown away as a bare null.
      assert.equal(check.value.latest, "4.17.5", "a failed refresh must not erase the last known-good value");
      assert.equal(check.value.cache.fresh, false, "honestly reported as stale, not silently presented as current");
      assert.equal(check.value.cache.refresh_attempted, true);
      assert.equal(check.value.cache.refresh_failed, true);
      assert.ok(check.value.cache.age_ms >= 24 * 60 * 60 * 1000, "the reported age reflects the ORIGINAL successful check, not the failed attempt just now");
      assert.equal(check.status, "warning", "a known-newer version is still worth flagging, even from stale data");
      assert.match(check.hint, /\d+d old/, "the hint must name the estimate's age");
      assert.match(check.hint, /live check just failed/);

      // The next run inherits this SAME good value — a failed refresh must
      // never clobber what was already known on disk either.
      const onDisk = readUpdateCache({ path: cachePath });
      assert.equal(onDisk.latest, "4.17.5");
      assert.equal(onDisk.checked_at, "2026-08-01T10:18:20.000Z");
      assert.ok(onDisk.error, "the failed attempt is still recorded, just not destructively");
    }));

    it("no cache at all AND the auto-refresh fails: unknown, not a crash — and it says a live check was attempted", () => withTemp(async (dir) => {
      const check = await doctorUpdateCheck({
        cwd: dir,
        current: "3.7.14",
        cachePath: join(dir, "missing.json"),
        fetchImpl: async () => { throw new Error("offline"); },
      });
      assert.equal(check.status, "unknown");
      assert.equal(check.value.cache.refresh_attempted, true);
      assert.equal(check.value.cache.refresh_failed, true);
    }));

    it("--refresh forces a live check even when the cache is still well within the TTL", () => withTemp(async (dir) => {
      const cachePath = join(dir, "cache.json");
      const now = Date.parse("2026-08-01T12:00:00.000Z");
      writeUpdateCache({
        current: "3.7.14",
        latest: "3.7.15",
        checked_at: new Date(now - 60 * 1000).toISOString(), // 1 minute old — as fresh as it gets
        source: "cache",
        error: null,
      }, { path: cachePath });
      let fetchCalls = 0;
      const check = await doctorUpdateCheck({
        cwd: dir,
        current: "3.7.14",
        cachePath,
        now,
        refresh: true,
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ version: "3.7.21" }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });
      assert.equal(fetchCalls, 1, "--refresh must check live regardless of freshness");
      assert.equal(check.value.latest, "3.7.21");
    }));
  });
});
