import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { LocalError, ProjectCredentialNotFound } from "../errors.js";
import type { CredentialsProvider, ProjectKeys } from "../credentials.js";

const known: ProjectKeys = {
  anon_key: "anon_secret_value",
  service_key: "service_secret_value",
  site_url: "https://example.run402.com",
  cached_at: "2026-07-03T00:00:00Z",
};

function sdk(overrides: Partial<CredentialsProvider> = {}) {
  const entries: Record<string, ProjectKeys> = { prj_known: { ...known } };
  return new Run402({
    apiBase: "https://api.example.test",
    credentials: {
      async getAuth() {
        return null;
      },
      async getProjectCredentials(id) {
        return entries[id] ?? null;
      },
      async listProjectCredentials() {
        return entries;
      },
      async saveProject(id, project) {
        entries[id] = project;
      },
      async removeProject(id) {
        delete entries[id];
      },
      getProjectCredentialCacheInfo() {
        return { source: "local_cache", cache_path: "/tmp/project-keys.v1.json", profile: "default" };
      },
      ...overrides,
    },
    fetch: async () => {
      throw new Error("unexpected fetch");
    },
  });
}

describe("credentials.projectKeys", () => {
  it("status redacts local project-key material", async () => {
    const result = await sdk().credentials.projectKeys.status("prj_known");

    assert.equal(result.source, "local_cache");
    assert.equal(result.configured, true);
    assert.equal(result.has_service_key, true);
    assert.equal(result.service_key_prefix, "service_...");
    assert.equal(result.site_url, "https://example.run402.com");
    assert.equal(JSON.stringify(result).includes("service_secret_value"), false);
  });

  it("list returns redacted local-cache entries with provenance", async () => {
    const result = await sdk().credentials.projectKeys.list();

    assert.equal(result.source, "local_cache");
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0]!.project_id, "prj_known");
    assert.equal(result.projects[0]!.cache_path, "/tmp/project-keys.v1.json");
    assert.equal(JSON.stringify(result).includes("anon_secret_value"), false);
  });

  it("export requires reveal before emitting secret material", async () => {
    await assert.rejects(
      () => sdk().credentials.projectKeys.export("prj_known"),
      (err: unknown) => err instanceof LocalError && err.code === "REVEAL_REQUIRED",
    );

    const result = await sdk().credentials.projectKeys.export("prj_known", { reveal: true });
    assert.equal(result.revealed, true);
    assert.equal(result.service_key, "service_secret_value");
    assert.equal(result.source, "local_cache");
  });

  it("export preserves ProjectCredentialNotFound for missing local keys", async () => {
    await assert.rejects(
      () => sdk().credentials.projectKeys.export("prj_missing", { reveal: true }),
      ProjectCredentialNotFound,
    );
  });

  it("import and remove delegate to provider persistence hooks", async () => {
    const client = sdk();

    const imported = await client.credentials.projectKeys.import("prj_new", {
      anonKey: "anon_new",
      serviceKey: "service_new",
    });
    assert.equal(imported.imported, true);
    assert.equal(imported.configured, true);

    const removed = await client.credentials.projectKeys.remove("prj_new");
    assert.equal(removed.removed, true);
    assert.equal(removed.configured, false);
  });
});
