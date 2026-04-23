import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleCreateMailbox } from "./create-mailbox.js";
import { _resetSdk } from "../sdk.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-mailbox-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  _resetSdk();

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

  it("returns isError on non-409 API error", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleCreateMailbox({
      project_id: "proj-001",
      slug: "my-app",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("500"));
  });

  it("recovers on 409 by discovering existing mailbox", async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string, opts?: RequestInit) => {
      callCount++;
      if (opts?.method === "POST") {
        return new Response(
          JSON.stringify({ error: "Project already has a mailbox" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      // GET /mailboxes/v1 — discovery
      return new Response(
        JSON.stringify({ mailboxes: [{ mailbox_id: "mbx-existing", address: "existing@mail.run402.com", slug: "existing" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleCreateMailbox({
      project_id: "proj-001",
      slug: "existing",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Already Exists"));
    assert.ok(result.content[0]!.text.includes("mbx-existing"));
    assert.ok(result.content[0]!.text.includes("existing@mail.run402.com"));
    assert.equal(callCount, 2);
  });

  it("falls through to error on 409 when discovery returns empty", async () => {
    globalThis.fetch = (async (_url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        return new Response(
          JSON.stringify({ error: "Project already has a mailbox" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      // GET /mailboxes/v1 — empty
      return new Response(
        JSON.stringify({ mailboxes: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleCreateMailbox({
      project_id: "proj-001",
      slug: "taken-slug",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("already has a mailbox"));
  });

  it("falls through to error on 409 when discovery fails", async () => {
    globalThis.fetch = (async (_url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        return new Response(
          JSON.stringify({ error: "Project already has a mailbox" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      // GET /mailboxes/v1 — fails
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleCreateMailbox({
      project_id: "proj-001",
      slug: "taken-slug",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("already has a mailbox"));
  });
});
