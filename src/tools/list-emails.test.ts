import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleListEmails } from "./list-emails.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-listemails-test-"));
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

describe("list_emails tool", () => {
  it("returns formatted table on success", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          { id: "msg-001", template: "project_invite", to: "a@b.com", status: "sent", created_at: "2026-03-24T10:00:00Z" },
          { id: "msg-002", template: "notification", to: "c@d.com", status: "sent", created_at: "2026-03-24T11:00:00Z" },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleListEmails({ project_id: "proj-001" });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Sent Emails (2)"));
    assert.ok(result.content[0]!.text.includes("msg-001"));
    assert.ok(result.content[0]!.text.includes("msg-002"));
  });

  it("returns empty message when no emails", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleListEmails({ project_id: "proj-001" });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("No emails sent yet"));
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

    const result = await handleListEmails({ project_id: "proj-001" });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("create_mailbox"));
  });
});
