import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleGetEmail } from "./get-email.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-getemail-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";

  const store = {
    projects: {
      "proj-001": {
        anon_key: "ak-123",
        service_key: "sk-456",
        mailbox_id: "mbx-001",
        mailbox_address: "my-app@mail.run402.com",
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

describe("get_email tool", () => {
  it("returns message details on success", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "msg-001",
          template: "project_invite",
          to: "user@example.com",
          status: "delivered",
          variables: { project_name: "My App", invite_url: "https://example.com" },
          created_at: "2026-03-24T10:00:00Z",
          replies: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleGetEmail({
      project_id: "proj-001",
      message_id: "msg-001",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("msg-001"));
    assert.ok(result.content[0]!.text.includes("project_invite"));
    assert.ok(result.content[0]!.text.includes("user@example.com"));
  });

  it("shows replies when present", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "msg-001",
          template: "project_invite",
          to: "user@example.com",
          status: "delivered",
          variables: {},
          created_at: "2026-03-24T10:00:00Z",
          replies: [
            { id: "rpl-001", from: "user@example.com", body: "Thanks!", received_at: "2026-03-24T12:00:00Z" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleGetEmail({
      project_id: "proj-001",
      message_id: "msg-001",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Replies (1)"));
    assert.ok(result.content[0]!.text.includes("Thanks!"));
  });

  it("returns isError on 404", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Message not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleGetEmail({
      project_id: "proj-001",
      message_id: "nonexistent",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found"));
  });

  it("returns isError when no mailbox exists", async () => {
    const store = {
      projects: {
        "proj-001": {
          anon_key: "ak-123",
          service_key: "sk-456",
        },
      },
    };
    writeFileSync(join(tempDir, "projects.json"), JSON.stringify(store));

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleGetEmail({
      project_id: "proj-001",
      message_id: "msg-001",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("create_mailbox"));
  });
});
