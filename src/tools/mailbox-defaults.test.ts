import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleListMailboxes } from "./list-mailboxes.js";
import { handleSetMailboxDefaults } from "./set-mailbox-defaults.js";
import { handleUpdateMailbox } from "./update-mailbox.js";
import { _resetSdk } from "../sdk.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-mailbox-defaults-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  _resetSdk();

  writeFileSync(join(tempDir, "projects.json"), JSON.stringify({
    projects: {
      "proj-001": {
        anon_key: "ak-123",
        service_key: "sk-456",
      },
    },
  }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  _resetSdk();
});

describe("mailbox defaults MCP tools", () => {
  it("list_mailboxes renders settings, readiness, and next actions", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        mailboxes: [{
          mailbox_id: "mbx_support",
          address: "support@mail.run402.com",
          slug: "support",
          project_id: "proj-001",
          status: "active",
          sends_today: 0,
          unique_recipients: 0,
          created_at: "2026-05-01T00:00:00.000Z",
          updated_at: "2026-05-01T00:00:00.000Z",
          is_default_outbound: true,
          is_auth_sender: false,
          can_send: true,
          send_blocked_reason: null,
          domain_kind: "shared",
          footer_policy: "none",
          effective_footer_policy: "none",
          footer_policy_locked_reason: null,
        }],
        mailbox_settings: {
          default_outbound_mailbox_id: "mbx_support",
          auth_sender_mailbox_id: null,
        },
        next_actions: [{ type: "set_mailbox_defaults" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

    const result = await handleListMailboxes({ project_id: "proj-001" });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0]!.text, /Default outbound:\*\* mbx_support/);
    assert.match(result.content[0]!.text, /Can send: true/);
    assert.match(result.content[0]!.text, /Footer policy: none/);
    assert.match(result.content[0]!.text, /set_mailbox_defaults/);
  });

  it("set_mailbox_defaults PATCHes mailbox settings", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({
        mailboxes: [],
        mailbox_settings: {
          default_outbound_mailbox_id: "mbx_support",
          auth_sender_mailbox_id: "mbx_auth",
        },
        next_actions: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const result = await handleSetMailboxDefaults({
      project_id: "proj-001",
      default_outbound_mailbox_id: "mbx_support",
      auth_sender_mailbox_id: "mbx_auth",
    });

    assert.equal(result.isError, undefined);
    assert.equal(calls[0]!.url, "https://test-api.run402.com/mailboxes/v1/settings");
    assert.equal(calls[0]!.method, "PATCH");
    assert.deepEqual(calls[0]!.body, {
      default_outbound_mailbox_id: "mbx_support",
      auth_sender_mailbox_id: "mbx_auth",
    });
    assert.match(result.content[0]!.text, /Auth sender:\*\* mbx_auth/);
  });

  it("update_mailbox PATCHes footer_policy", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({
        mailbox_id: "mbx_support",
        address: "support@mail.run402.com",
        slug: "support",
        project_id: "proj-001",
        status: "active",
        sends_today: 0,
        unique_recipients: 0,
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
        footer_policy: "none",
        effective_footer_policy: "none",
        footer_policy_locked_reason: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const result = await handleUpdateMailbox({
      project_id: "proj-001",
      mailbox: "mbx_support",
      footer_policy: "none",
    });

    assert.equal(result.isError, undefined);
    assert.equal(calls[0]!.url, "https://test-api.run402.com/mailboxes/v1/mbx_support");
    assert.equal(calls[0]!.method, "PATCH");
    assert.deepEqual(calls[0]!.body, { footer_policy: "none" });
    assert.match(result.content[0]!.text, /Effective footer policy:\*\* none/);
  });
});
