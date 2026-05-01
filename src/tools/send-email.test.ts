import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSendEmail } from "./send-email.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-sendemail-test-"));
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

describe("send_email tool", () => {
  it("returns success on 200", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ message_id: "msg-001", status: "sent", to: "user@example.com", template: "project_invite", subject: null, sent_at: "2026-05-01T00:00:00.000Z" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleSendEmail({
      project_id: "proj-001",
      template: "project_invite",
      to: "user@example.com",
      variables: { project_name: "My App", invite_url: "https://example.com/invite" },
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Email Sent"));
    assert.ok(result.content[0]!.text.includes("msg-001"));
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleSendEmail({
      project_id: "nonexistent",
      template: "project_invite",
      to: "user@example.com",
      variables: { project_name: "App" },
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });

  it("returns isError when no mailbox exists", async () => {
    // Overwrite store without mailbox_id
    const store = {
      projects: {
        "proj-001": {
          anon_key: "ak-123",
          service_key: "sk-456",
        },
      },
    };
    writeFileSync(join(tempDir, "projects.json"), JSON.stringify(store));

    // Mock GET /mailboxes/v1 returning empty array
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleSendEmail({
      project_id: "proj-001",
      template: "project_invite",
      to: "user@example.com",
      variables: { project_name: "App" },
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("create_mailbox"));
  });

  it("sends raw HTML email with subject and html", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ message_id: "msg-002", status: "sent", to: "user@example.com", subject: "Welcome!", template: null, sent_at: "2026-05-01T00:00:00.000Z" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleSendEmail({
      project_id: "proj-001",
      to: "user@example.com",
      subject: "Welcome!",
      html: "<h1>Hello</h1>",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Email Sent"));
    assert.ok(result.content[0]!.text.includes("Subject:"));
    const parsed = JSON.parse(capturedBody!);
    assert.equal(parsed.subject, "Welcome!");
    assert.equal(parsed.html, "<h1>Hello</h1>");
    assert.equal(parsed.template, undefined);
  });

  it("sends from_name when provided", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ message_id: "msg-003", status: "sent", to: "user@example.com", subject: "Hi", template: null, sent_at: "2026-05-01T00:00:00.000Z" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleSendEmail({
      project_id: "proj-001",
      to: "user@example.com",
      subject: "Hi",
      html: "<p>hey</p>",
      from_name: "My App",
    });

    const parsed = JSON.parse(capturedBody!);
    assert.equal(parsed.from_name, "My App");
  });

  it("returns error when neither template nor subject/html provided", async () => {
    const result = await handleSendEmail({
      project_id: "proj-001",
      to: "user@example.com",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("template"));
    assert.ok(result.content[0]!.text.includes("html"));
  });

  it("returns isError on API error", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Rate limit exceeded" }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleSendEmail({
      project_id: "proj-001",
      template: "project_invite",
      to: "user@example.com",
      variables: { project_name: "App" },
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("Rate limit"));
  });
});
