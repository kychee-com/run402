import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureApiBase } from "../../core-dist/config.js";
import { LocalError } from "../errors.js";
import { resolveRun402TargetProfile } from "./target-profile.js";

let tempDir: string;

const originalEnv = {
  RUN402_API_BASE: process.env.RUN402_API_BASE,
  RUN402_CONFIG_DIR: process.env.RUN402_CONFIG_DIR,
  RUN402_PROJECT_ID: process.env.RUN402_PROJECT_ID,
  RUN402_ANON_KEY: process.env.RUN402_ANON_KEY,
  RUN402_SERVICE_KEY: process.env.RUN402_SERVICE_KEY,
  RUN402_WALLET: process.env.RUN402_WALLET,
  RUN402_PROFILE: process.env.RUN402_PROFILE,
  KYCHON_PROJECT_ID: process.env.KYCHON_PROJECT_ID,
  ANON_KEY: process.env.ANON_KEY,
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-target-profile-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  delete process.env.RUN402_API_BASE;
  delete process.env.RUN402_PROJECT_ID;
  delete process.env.RUN402_ANON_KEY;
  delete process.env.RUN402_SERVICE_KEY;
  delete process.env.RUN402_WALLET;
  delete process.env.RUN402_PROFILE;
  delete process.env.KYCHON_PROJECT_ID;
  delete process.env.ANON_KEY;
});

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("resolveRun402TargetProfile", () => {
  it("resolves a Core target and active project from the shared profile store", () => {
    configureApiBase("http://core.local:4020", { target_kind: "core" });
    writeFileSync(
      join(tempDir, "projects.json"),
      JSON.stringify({
        active_project_id: "prj_profile",
        projects: {
          prj_profile: {
            anon_key: "anon_profile",
            service_key: "service_profile",
            site_url: "http://core.local:4020/projects/prj_profile/site",
          },
        },
      }),
      "utf-8",
    );

    const target = resolveRun402TargetProfile({
      requiredTarget: "core",
      requireProject: true,
      requireAnonKey: true,
    });

    assert.equal(target.apiBase, "http://core.local:4020");
    assert.equal(target.apiBaseSource, "profile");
    assert.equal(target.targetKind, "core");
    assert.equal(target.isCore, true);
    assert.equal(target.projectId, "prj_profile");
    assert.equal(target.anonKey, "anon_profile");
    assert.equal(target.serviceKey, "service_profile");
    assert.equal(target.sources.project, "profile:active_project_id");
    assert.equal(target.sources.anonKey, "profile:projects.json");
  });

  it("supports app-specific env aliases without app repos parsing projects.json", () => {
    process.env.RUN402_API_BASE = "http://127.0.0.1:4020";
    process.env.KYCHON_PROJECT_ID = "prj_env";
    process.env.ANON_KEY = "anon_env";

    const target = resolveRun402TargetProfile({
      requiredTarget: "core",
      requireProject: true,
      requireAnonKey: true,
      envAliases: {
        projectId: ["KYCHON_PROJECT_ID"],
        anonKey: ["ANON_KEY"],
      },
    });

    assert.equal(target.apiBase, "http://127.0.0.1:4020");
    assert.equal(target.apiBaseSource, "env");
    assert.equal(target.targetKind, "core");
    assert.equal(target.projectId, "prj_env");
    assert.equal(target.anonKey, "anon_env");
    assert.equal(target.sources.project, "env:KYCHON_PROJECT_ID");
    assert.equal(target.sources.anonKey, "env:ANON_KEY");
  });

  it("throws a structured local error when the target kind is wrong", () => {
    assert.throws(
      () => resolveRun402TargetProfile({ requiredTarget: "core" }),
      (err) => err instanceof LocalError &&
        err.code === "RUN402_TARGET_MISMATCH" &&
        err.message.includes("resolved cloud"),
    );
  });

  it("throws a structured local error when a required anon key is absent", () => {
    configureApiBase("http://core.local:4020", { target_kind: "core" });
    assert.throws(
      () => resolveRun402TargetProfile({ requiredTarget: "core", requireAnonKey: true }),
      (err) => err instanceof LocalError &&
        err.code === "RUN402_TARGET_ANON_KEY_REQUIRED",
    );
  });
});
