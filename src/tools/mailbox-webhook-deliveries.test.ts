import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleListMailboxWebhookDeliveries } from "./list-mailbox-webhook-deliveries.js";
import { handleRedriveMailboxWebhookDelivery } from "./redrive-mailbox-webhook-delivery.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

function mailboxListResponse(): Response {
  return new Response(
    JSON.stringify({
      mailboxes: [{
        mailbox_id: "mbx-001",
        address: "my-app@proj-001.mail.run402.com",
        managed_address: "my-app@proj-001.mail.run402.com",
        slug: "my-app",
        project_id: "proj-001",
        status: "active",
        sends_today: 0,
        unique_recipients: 0,
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
      }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function isMailboxListGet(url: string | URL | Request, init?: RequestInit): boolean {
  return String(url).endsWith("/mailboxes/v1") && (!init?.method || init.method === "GET");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-deliveries-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  writeFileSync(
    join(tempDir, "projects.json"),
    JSON.stringify({ projects: { "proj-001": { anon_key: "ak", service_key: "sk", mailbox_id: "mbx-001", mailbox_address: "my-app@proj-001.mail.run402.com" } } }),
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("list_mailbox_webhook_deliveries tool", () => {
  it("renders a table and passes the status filter", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (isMailboxListGet(url, init)) return mailboxListResponse();
      seenUrl = String(url);
      return new Response(
        JSON.stringify({
          deliveries: [
            { delivery_id: "wd1", webhook_id: "whk1", event_type: "reply_received", status: "failed_permanent", attempts: 5, last_status: 500, last_error: "http_500", next_attempt_at: null, delivered_at: null, created_at: "2026-05-29T00:00:00Z" },
          ],
          has_more: false,
          next_cursor: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleListMailboxWebhookDeliveries({ project_id: "proj-001", status: "failed_permanent" });
    assert.equal(result.isError, undefined);
    assert.ok(seenUrl.includes("/webhooks/deliveries"));
    assert.ok(seenUrl.includes("status=failed_permanent"));
    assert.ok(result.content[0]!.text.includes("wd1"));
    assert.ok(result.content[0]!.text.includes("idempotency_key"));
  });

  it("renders an empty-state when no deliveries match", async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (isMailboxListGet(url, init)) return mailboxListResponse();
      return new Response(JSON.stringify({ deliveries: [], has_more: false, next_cursor: null }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const result = await handleListMailboxWebhookDeliveries({ project_id: "proj-001" });
    assert.ok(result.content[0]!.text.includes("No deliveries"));
  });
});

describe("redrive_mailbox_webhook_delivery tool", () => {
  it("POSTs the redrive and confirms", async () => {
    let method = "";
    let seenUrl = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (isMailboxListGet(url, init)) return mailboxListResponse();
      method = init?.method ?? "GET";
      seenUrl = String(url);
      return new Response(
        JSON.stringify({ status: "requeued", delivery: { delivery_id: "wd1", event_type: "reply_received", status: "pending" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleRedriveMailboxWebhookDelivery({ project_id: "proj-001", delivery_id: "wd1" });
    assert.equal(result.isError, undefined);
    assert.equal(method, "POST");
    assert.ok(seenUrl.endsWith("/webhooks/deliveries/wd1/redrive"));
    assert.ok(result.content[0]!.text.includes("Re-queued"));
  });
});
