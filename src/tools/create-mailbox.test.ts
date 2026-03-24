import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleCreateMailbox } from "./create-mailbox.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-mailbox-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";

  const store = {
    projects: {
      "proj-001": {
        anon_key: "ak-123",
        service_key: "sk-456",
      },
    },
  };
  writeFileSync(join(tempDir, "projects.json"), JSON.stringify(store));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("create_mailbox tool", () => {
  it("returns success on 200 and stores mailbox_id", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ id: "mbx-001", address: "my-app@mail.run402.com", slug: "my-app", status: "active" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleCreateMailbox({
      project_id: "proj-001",
      slug: "my-app",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Mailbox Created"));
    assert.ok(result.content[0]!.text.includes("my-app@mail.run402.com"));
  });

  it("rejects slug shorter than 3 chars", async () => {
    const result = await handleCreateMailbox({
      project_id: "proj-001",
      slug: "ab",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("3-63"));
  });

  it("rejects slug with uppercase", async () => {
    const result = await handleCreateMailbox({
      project_id: "proj-001",
      slug: "MyApp",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("lowercase"));
  });

  it("rejects slug with consecutive hyphens", async () => {
    const result = await handleCreateMailbox({
      project_id: "proj-001",
      slug: "my--app",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("consecutive"));
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleCreateMailbox({
      project_id: "nonexistent",
      slug: "my-app",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });

  it("returns isError on API error", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Slug already taken" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleCreateMailbox({
      project_id: "proj-001",
      slug: "taken-slug",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("already taken"));
  });
});
