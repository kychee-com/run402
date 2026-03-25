import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleGetMailbox } from "./get-mailbox.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-get-mailbox-test-"));
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

describe("get_mailbox tool", () => {
  it("returns mailbox info on success", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ mailboxes: [{ mailbox_id: "mbx-001", address: "my-app@mail.run402.com", slug: "my-app" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleGetMailbox({ project_id: "proj-001" });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("mbx-001"));
    assert.ok(result.content[0]!.text.includes("my-app@mail.run402.com"));
    assert.ok(result.content[0]!.text.includes("my-app"));
  });

  it("handles array response format", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([{ mailbox_id: "mbx-002", address: "test@mail.run402.com" }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleGetMailbox({ project_id: "proj-001" });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("mbx-002"));
    assert.ok(result.content[0]!.text.includes("test@mail.run402.com"));
  });

  it("returns error when no mailbox found", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ mailboxes: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleGetMailbox({ project_id: "proj-001" });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("No mailbox found"));
  });

  it("returns error when project not in keystore", async () => {
    const result = await handleGetMailbox({ project_id: "nonexistent" });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });

  it("returns error on API failure", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleGetMailbox({ project_id: "proj-001" });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("401"));
  });
});
