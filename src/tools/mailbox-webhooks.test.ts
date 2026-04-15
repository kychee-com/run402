import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleListMailboxWebhooks } from "./list-mailbox-webhooks.js";
import { handleGetMailboxWebhook } from "./get-mailbox-webhook.js";
import { handleDeleteMailboxWebhook } from "./delete-mailbox-webhook.js";
import { handleUpdateMailboxWebhook } from "./update-mailbox-webhook.js";
import { handleRegisterMailboxWebhook } from "./register-mailbox-webhook.js";

const originalFetch = globalThis.fetch;
let tempDir: string;
let fetchCallCount: number;

function setupKeystore() {
  tempDir = mkdtempSync(join(tmpdir(), "run402-webhook-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  const store = {
    projects: {
      "proj-001": { anon_key: "ak-123", service_key: "sk-456" },
    },
  };
  writeFileSync(join(tempDir, "projects.json"), JSON.stringify(store));
}

/** Mock fetch that returns mailbox list first, then the webhook response */
function mockFetchSequence(webhookResponse: Response) {
  fetchCallCount = 0;
  globalThis.fetch = (async () => {
    fetchCallCount++;
    if (fetchCallCount === 1) {
      // First call: resolve mailbox
      return new Response(
        JSON.stringify({ mailboxes: [{ mailbox_id: "mbx-001", address: "app@mail.run402.com" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return webhookResponse;
  }) as typeof fetch;
}

beforeEach(() => {
  setupKeystore();
  fetchCallCount = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

// ---------------------------------------------------------------------------
// list_mailbox_webhooks
// ---------------------------------------------------------------------------

describe("list_mailbox_webhooks tool", () => {
  it("returns webhooks on success", async () => {
    mockFetchSequence(new Response(
      JSON.stringify({ webhooks: [{ webhook_id: "whk_1", url: "https://example.com/hook", events: ["delivery"], created_at: "2026-01-01T00:00:00Z" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const result = await handleListMailboxWebhooks({ project_id: "proj-001" });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("whk_1"));
  });

  it("returns message when no webhooks", async () => {
    mockFetchSequence(new Response(
      JSON.stringify({ webhooks: [] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const result = await handleListMailboxWebhooks({ project_id: "proj-001" });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("No webhooks"));
  });

  it("returns error for unknown project", async () => {
    const result = await handleListMailboxWebhooks({ project_id: "nonexistent" });
    assert.equal(result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// get_mailbox_webhook
// ---------------------------------------------------------------------------

describe("get_mailbox_webhook tool", () => {
  it("returns webhook on success", async () => {
    mockFetchSequence(new Response(
      JSON.stringify({ webhook_id: "whk_1", url: "https://example.com/hook", events: ["delivery"], created_at: "2026-01-01T00:00:00Z" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const result = await handleGetMailboxWebhook({ project_id: "proj-001", webhook_id: "whk_1" });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("whk_1"));
    assert.ok(result.content[0]!.text.includes("https://example.com/hook"));
  });

  it("returns error on 404", async () => {
    mockFetchSequence(new Response(
      JSON.stringify({ error: "Webhook not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    ));
    const result = await handleGetMailboxWebhook({ project_id: "proj-001", webhook_id: "whk_missing" });
    assert.equal(result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// delete_mailbox_webhook
// ---------------------------------------------------------------------------

describe("delete_mailbox_webhook tool", () => {
  it("returns success on 204", async () => {
    mockFetchSequence(new Response(null, { status: 204 }));
    const result = await handleDeleteMailboxWebhook({ project_id: "proj-001", webhook_id: "whk_1" });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("deleted"));
  });

  it("returns error for unknown project", async () => {
    const result = await handleDeleteMailboxWebhook({ project_id: "nonexistent", webhook_id: "whk_1" });
    assert.equal(result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// update_mailbox_webhook
// ---------------------------------------------------------------------------

describe("update_mailbox_webhook tool", () => {
  it("updates url on success", async () => {
    mockFetchSequence(new Response(
      JSON.stringify({ webhook_id: "whk_1", url: "https://new.example.com", events: ["delivery"], created_at: "2026-01-01T00:00:00Z" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const result = await handleUpdateMailboxWebhook({ project_id: "proj-001", webhook_id: "whk_1", url: "https://new.example.com" });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("new.example.com"));
  });

  it("returns error when no fields provided", async () => {
    const result = await handleUpdateMailboxWebhook({ project_id: "proj-001", webhook_id: "whk_1" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("url"));
  });
});

// ---------------------------------------------------------------------------
// register_mailbox_webhook
// ---------------------------------------------------------------------------

describe("register_mailbox_webhook tool", () => {
  it("registers webhook on success", async () => {
    mockFetchSequence(new Response(
      JSON.stringify({ webhook_id: "whk_new", url: "https://example.com/hook", events: ["delivery", "bounced"] }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    ));
    const result = await handleRegisterMailboxWebhook({ project_id: "proj-001", url: "https://example.com/hook", events: ["delivery", "bounced"] });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("whk_new"));
  });

  it("returns error on API failure", async () => {
    mockFetchSequence(new Response(
      JSON.stringify({ error: "Invalid event" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    ));
    const result = await handleRegisterMailboxWebhook({ project_id: "proj-001", url: "https://example.com/hook", events: ["invalid"] });
    assert.equal(result.isError, true);
  });
});
