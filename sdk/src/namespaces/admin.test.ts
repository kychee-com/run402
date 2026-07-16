import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Run402 } from "../index.js";
import { LocalError } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";

function creds(): CredentialsProvider {
  return {
    async getAuth() { return { "SIGN-IN-WITH-X": "t" }; },
    async getProject() { return null; },
  };
}

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }
function mockFetch(h: (c: Call) => Response): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    };
    calls.push(call);
    return h(call);
  };
  return { fetch, calls };
}

function sdk(f: typeof globalThis.fetch): Run402 {
  return new Run402({ apiBase: "https://api.test", credentials: creds(), fetch: f });
}

function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
}

function contactEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    wallet: "0xtest",
    name: "test-agent",
    email: "ops@example.com",
    webhook: null,
    email_verification_status: "pending",
    passkey_binding_status: "none",
    assurance_level: "email_pending",
    email_verified_at: null,
    email_verified_message_id: null,
    email_challenge_sent_at: "2026-05-06T12:00:00Z",
    passkey_bound_at: null,
    active_operator_passkey_id: null,
    updated_at: "2026-05-06T12:00:00Z",
    ...overrides,
  };
}

describe("admin.sendMessage", () => {
  it("POSTs /message/v1 with the message body", async () => {
    const { fetch, calls } = mockFetch(() => json({ status: "sent" }));
    await sdk(fetch).admin.sendMessage("hello there");
    assert.equal(calls[0]!.url, "https://api.test/message/v1");
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { message: "hello there" });
  });

  it("returns the gateway envelope with status", async () => {
    const { fetch } = mockFetch(() => json({ status: "sent" }));
    const result = await sdk(fetch).admin.sendMessage("hi");
    assert.equal(result.status, "sent");
  });
});

describe("admin agent contact assurance", () => {
  it("sets contact info and returns assurance fields", async () => {
    const { fetch, calls } = mockFetch(() => json(contactEnvelope()));

    const result = await sdk(fetch).admin.setAgentContact({
      name: "test-agent",
      email: "ops@example.com",
    });

    assert.equal(calls[0]!.url, "https://api.test/agent/v1/contact");
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      name: "test-agent",
      email: "ops@example.com",
    });
    assert.equal(result.assurance_level, "email_pending");
    assert.equal(result.email_verification_status, "pending");
  });

  it("gets contact status", async () => {
    const { fetch, calls } = mockFetch(() => json(contactEnvelope({
      email_verification_status: "verified",
      assurance_level: "email_verified",
    })));

    const result = await sdk(fetch).admin.getAgentContactStatus();

    assert.equal(calls[0]!.url, "https://api.test/agent/v1/contact/status");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(result.assurance_level, "email_verified");
  });

  it("starts email verification", async () => {
    const { fetch, calls } = mockFetch(() => json(contactEnvelope({
      verification_retry_after_seconds: 60,
    })));

    const result = await sdk(fetch).admin.verifyAgentContactEmail();

    assert.equal(calls[0]!.url, "https://api.test/agent/v1/contact/verify-email");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(result.verification_retry_after_seconds, 60);
  });

  it("starts operator passkey enrollment", async () => {
    const { fetch, calls } = mockFetch(() => json(contactEnvelope({
      passkey_binding_status: "pending",
      assurance_level: "passkey_pending",
      enrollment_sent_to: "ops@example.com",
    })));

    const result = await sdk(fetch).admin.startOperatorPasskeyEnrollment();

    assert.equal(calls[0]!.url, "https://api.test/agent/v1/contact/passkey/enroll");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(result.enrollment_sent_to, "ops@example.com");
  });
});

describe("admin.getProjectFinance", () => {
  it("GETs the admin finance project endpoint with window and optional cookie", async () => {
    const { fetch, calls } = mockFetch(() => json({
      project_id: "prj_known",
      project_name: "Test Project",
      window: "7d",
      revenue_usd_micros: 6_650_000,
      direct_cost_usd_micros: 1_650_000,
      direct_margin_usd_micros: 5_000_000,
      revenue_breakdown: {
        tier_fees_usd_micros: 5_000_000,
        email_packs_usd_micros: 0,
        kms_rental_usd_micros: 1_200_000,
        kms_sign_fees_usd_micros: 450_000,
        per_call_sku_usd_micros: 0,
      },
      direct_cost_breakdown: [
        { category: "KMS wallet rental", cost_usd_micros: 1_200_000 },
        { category: "Chain gas passthrough", cost_usd_micros: 450_000 },
      ],
      notes: "Direct costs only.",
    }));

    const result = await sdk(fetch).admin.getProjectFinance("prj_known", {
      window: "7d",
      cookie: "run402_admin=session",
    });

    assert.equal(
      calls[0]!.url,
      "https://api.test/admin/api/finance/project/prj_known?window=7d",
    );
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers.Cookie, "run402_admin=session");
    assert.equal(calls[0]!.headers["X-Admin-Mode"], "1");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "t");
    assert.equal(result.direct_cost_usd_micros, 1_650_000);
    assert.equal(result.direct_cost_breakdown[0]!.category, "KMS wallet rental");
  });

  it("defaults to 30d", async () => {
    const { fetch, calls } = mockFetch(() => json({
      project_id: "prj_known",
      project_name: "Test Project",
      window: "30d",
      revenue_usd_micros: 0,
      direct_cost_usd_micros: 0,
      direct_margin_usd_micros: 0,
      revenue_breakdown: {
        tier_fees_usd_micros: 0,
        email_packs_usd_micros: 0,
        kms_rental_usd_micros: 0,
        kms_sign_fees_usd_micros: 0,
        per_call_sku_usd_micros: 0,
      },
      direct_cost_breakdown: [],
      notes: "Direct costs only.",
    }));

    await sdk(fetch).admin.getProjectFinance("prj_known");

    assert.equal(
      calls[0]!.url,
      "https://api.test/admin/api/finance/project/prj_known?window=30d",
    );
    assert.equal(calls[0]!.headers.Cookie, undefined);
    assert.equal(calls[0]!.headers["X-Admin-Mode"], "1");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "t");
  });

  it("rejects invalid windows before making a request", async () => {
    const { fetch, calls } = mockFetch(() => json({}));

    await assert.rejects(
      sdk(fetch).admin.getProjectFinance("prj_known", { window: "1y" as "30d" }),
      LocalError,
    );
    assert.equal(calls.length, 0);
  });
});

describe("admin.setLeasePerpetual (v1.57)", () => {
  it("POSTs to /orgs/v1/admin/:org_id/lease-perpetual with admin headers", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        status: "ok",
        org_id: "org_known",
        lease_perpetual: true,
        reactivated: true,
      }),
    );
    const result = await sdk(fetch).admin.setLeasePerpetual("org_known", true);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(
      calls[0]!.url,
      "https://api.test/orgs/v1/admin/org_known/lease-perpetual",
    );
    assert.equal(calls[0]!.headers["X-Admin-Mode"], "1");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "t");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { lease_perpetual: true });
    assert.equal(result.lease_perpetual, true);
    assert.equal(result.reactivated, true);
  });

  it("sends false to disable perpetual", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ status: "ok", org_id: "org_known", lease_perpetual: false, reactivated: false }),
    );
    const result = await sdk(fetch).admin.setLeasePerpetual("org_known", false);

    assert.deepEqual(JSON.parse(calls[0]!.body as string), { lease_perpetual: false });
    assert.equal(result.lease_perpetual, false);
    assert.equal(result.reactivated, false);
  });

  it("URI-encodes the organization id", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ status: "ok", org_id: "org/has space", lease_perpetual: true, reactivated: false }),
    );
    await sdk(fetch).admin.setLeasePerpetual("org/has space", true);
    assert.equal(
      calls[0]!.url,
      "https://api.test/orgs/v1/admin/org%2Fhas%20space/lease-perpetual",
    );
  });
});

describe("admin.archiveProject (v1.57)", () => {
  it("POSTs to /projects/v1/admin/:id/archive and forwards the reason", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        status: "ok",
        project_id: "prj_known",
        archived_at: "2026-05-06T12:00:00.000Z",
        reason: "ToS abuse",
      }),
    );
    const result = await sdk(fetch).admin.archiveProject("prj_known", { reason: "ToS abuse" });

    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url, "https://api.test/projects/v1/admin/prj_known/archive");
    assert.equal(calls[0]!.headers["X-Admin-Mode"], "1");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { reason: "ToS abuse" });
    assert.equal(result.archived_at, "2026-05-06T12:00:00.000Z");
    assert.equal(result.reason, "ToS abuse");
  });

  it("sends an empty body when no reason is given", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ status: "ok", project_id: "prj_known", archived_at: "2026-05-06T12:00:00.000Z" }),
    );
    await sdk(fetch).admin.archiveProject("prj_known");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {});
  });

  it("surfaces the 'already archived' no-op envelope without throwing", async () => {
    const { fetch } = mockFetch(() =>
      json({ status: "ok", project_id: "prj_known", note: "already archived" }),
    );
    const result = await sdk(fetch).admin.archiveProject("prj_known", { reason: "second try" });
    assert.equal(result.note, "already archived");
    assert.equal(result.archived_at, undefined);
  });
});

describe("admin.reactivateProject (v1.57)", () => {
  it("POSTs to /projects/v1/admin/:id/reactivate", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ status: "ok", project_id: "prj_known", reactivated: true }),
    );
    const result = await sdk(fetch).admin.reactivateProject("prj_known");

    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url, "https://api.test/projects/v1/admin/prj_known/reactivate");
    assert.equal(calls[0]!.headers["X-Admin-Mode"], "1");
    assert.equal(result.reactivated, true);
  });

  it("surfaces the 'not archived' no-op envelope without throwing", async () => {
    const { fetch } = mockFetch(() =>
      json({ status: "ok", project_id: "prj_known", note: "not archived" }),
    );
    const result = await sdk(fetch).admin.reactivateProject("prj_known");
    assert.equal(result.note, "not archived");
    assert.equal(result.reactivated, undefined);
  });
});

// ---------------------------------------------------------------------------
// notification-channel-routing-telegram — r.admin.channels / r.admin.rules.
// ---------------------------------------------------------------------------

describe("admin.channels.connectTelegram", () => {
  it("POSTs /agent/v1/notifications/channels/telegram with the label", async () => {
    const { fetch, calls } = mockFetch(() =>
      json(
        {
          binding_id: "bnd_1",
          status: "pending",
          connect_url: "https://t.me/run402_notify_bot?start=abc123",
          connect_group_url: "https://t.me/run402_notify_bot?startgroup=abc123",
          code_expires_at: "2026-07-16T12:15:00.000Z",
          label: "kychon alerts",
          next_actions: [{ type: "open_telegram_connect_url", why: "tap it" }],
        },
        201,
      ),
    );
    const result = await sdk(fetch).admin.channels.connectTelegram({ label: "kychon alerts" });

    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url, "https://api.test/agent/v1/notifications/channels/telegram");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { label: "kychon alerts" });
    assert.equal(result.binding_id, "bnd_1");
    assert.equal(result.status, "pending");
    assert.equal(result.connect_url, "https://t.me/run402_notify_bot?start=abc123");
    assert.equal(result.connect_group_url, "https://t.me/run402_notify_bot?startgroup=abc123");
    assert.equal(result.next_actions.length, 1);
  });

  it("sends an empty body when no label is given", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        binding_id: "bnd_2",
        status: "pending",
        connect_url: "https://t.me/run402_notify_bot?start=xyz",
        connect_group_url: "https://t.me/run402_notify_bot?startgroup=xyz",
        code_expires_at: "2026-07-16T12:15:00.000Z",
        label: null,
        next_actions: [],
      }),
    );
    await sdk(fetch).admin.channels.connectTelegram();
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {});
  });
});

describe("admin.channels.list", () => {
  it("GETs /agent/v1/notifications/channels and returns email/webhook/telegram", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        email: { address: "ops@example.com", verified: true },
        webhook: { configured: false, url: null, secret_configured: false },
        telegram: [
          {
            id: "bnd_1",
            recipient_email: "ops@example.com",
            status: "active",
            chat_id: 12345,
            chat_type: "private",
            chat_title: null,
            label: "kychon alerts",
            consecutive_failures: 0,
            disabled_at: null,
            code_expires_at: null,
            created_at: "2026-07-16T12:00:00.000Z",
            activated_at: "2026-07-16T12:05:00.000Z",
          },
        ],
      }),
    );
    const result = await sdk(fetch).admin.channels.list();

    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.url, "https://api.test/agent/v1/notifications/channels");
    assert.equal(result.email.verified, true);
    assert.equal(result.telegram.length, 1);
    assert.equal(result.telegram[0]!.status, "active");
  });
});

describe("admin.channels.revokeTelegram", () => {
  it("DELETEs /agent/v1/notifications/channels/telegram/:binding_id", async () => {
    const { fetch, calls } = mockFetch(() => json({ status: "revoked", binding_id: "bnd_1" }));
    const result = await sdk(fetch).admin.channels.revokeTelegram("bnd_1");

    assert.equal(calls[0]!.method, "DELETE");
    assert.equal(calls[0]!.url, "https://api.test/agent/v1/notifications/channels/telegram/bnd_1");
    assert.equal(result.status, "revoked");
    assert.equal(result.binding_id, "bnd_1");
  });

  it("URI-encodes the binding id", async () => {
    const { fetch, calls } = mockFetch(() => json({ status: "revoked", binding_id: "bnd/weird id" }));
    await sdk(fetch).admin.channels.revokeTelegram("bnd/weird id");
    assert.equal(
      calls[0]!.url,
      "https://api.test/agent/v1/notifications/channels/telegram/bnd%2Fweird%20id",
    );
  });
});

describe("admin.rules.list", () => {
  it("GETs /agent/v1/notifications/rules", async () => {
    const { fetch, calls } = mockFetch(() => json({ rules: [] }));
    const result = await sdk(fetch).admin.rules.list();
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.url, "https://api.test/agent/v1/notifications/rules");
    assert.deepEqual(result.rules, []);
  });
});

describe("admin.rules.create", () => {
  it("POSTs snake_case body with only telegram_binding_id when no filters are given", async () => {
    const { fetch, calls } = mockFetch(() =>
      json(
        {
          id: "rule_1",
          recipient_email: "ops@example.com",
          project_id: null,
          source: null,
          event_types: null,
          classes: null,
          channel: "telegram",
          telegram_binding_id: "bnd_1",
          enabled: true,
          created_at: "2026-07-16T12:00:00.000Z",
          updated_at: "2026-07-16T12:00:00.000Z",
          next_actions: [{ type: "test_notification", method: "POST", path: "/agent/v1/notifications/test" }],
        },
        201,
      ),
    );
    const result = await sdk(fetch).admin.rules.create({ telegramBindingId: "bnd_1" });

    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url, "https://api.test/agent/v1/notifications/rules");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { telegram_binding_id: "bnd_1" });
    assert.equal(result.id, "rule_1");
    assert.equal(result.telegram_binding_id, "bnd_1");
    assert.equal(result.next_actions.length, 1);
  });

  it("forwards every match dimension in snake_case", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        id: "rule_2",
        recipient_email: "ops@example.com",
        project_id: "prj_abc",
        source: "app",
        event_types: ["signature_failed"],
        classes: null,
        channel: "telegram",
        telegram_binding_id: "bnd_1",
        enabled: true,
        created_at: "2026-07-16T12:00:00.000Z",
        updated_at: "2026-07-16T12:00:00.000Z",
        next_actions: [],
      }),
    );
    await sdk(fetch).admin.rules.create({
      telegramBindingId: "bnd_1",
      projectId: "prj_abc",
      source: "app",
      eventTypes: ["signature_failed"],
      classes: null,
    });
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      telegram_binding_id: "bnd_1",
      project_id: "prj_abc",
      source: "app",
      event_types: ["signature_failed"],
      classes: null,
    });
  });
});

describe("admin.rules.update — PATCH null-vs-absent semantics", () => {
  it("omits a field entirely from the wire body when not present in the patch", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        id: "rule_1",
        recipient_email: "ops@example.com",
        project_id: "prj_abc",
        source: null,
        event_types: null,
        classes: null,
        channel: "telegram",
        telegram_binding_id: "bnd_1",
        enabled: false,
        created_at: "2026-07-16T12:00:00.000Z",
        updated_at: "2026-07-16T12:10:00.000Z",
      }),
    );
    await sdk(fetch).admin.rules.update("rule_1", { enabled: false });
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { enabled: false });
  });

  it("sends an explicit null to CLEAR a dimension back to wildcard", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        id: "rule_1",
        recipient_email: "ops@example.com",
        project_id: null,
        source: null,
        event_types: null,
        classes: null,
        channel: "telegram",
        telegram_binding_id: "bnd_1",
        enabled: true,
        created_at: "2026-07-16T12:00:00.000Z",
        updated_at: "2026-07-16T12:10:00.000Z",
      }),
    );
    await sdk(fetch).admin.rules.update("rule_1", { projectId: null });
    const body = JSON.parse(calls[0]!.body as string);
    assert.equal("project_id" in body, true);
    assert.equal(body.project_id, null);
  });

  it("PATCHes /agent/v1/notifications/rules/:rule_id (URI-encoded)", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        id: "rule/weird",
        recipient_email: "ops@example.com",
        project_id: null,
        source: null,
        event_types: null,
        classes: null,
        channel: "telegram",
        telegram_binding_id: "bnd_1",
        enabled: true,
        created_at: "2026-07-16T12:00:00.000Z",
        updated_at: "2026-07-16T12:10:00.000Z",
      }),
    );
    await sdk(fetch).admin.rules.update("rule/weird", { telegramBindingId: "bnd_2" });
    assert.equal(calls[0]!.method, "PATCH");
    assert.equal(calls[0]!.url, "https://api.test/agent/v1/notifications/rules/rule%2Fweird");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { telegram_binding_id: "bnd_2" });
  });
});

describe("admin.rules.delete", () => {
  it("DELETEs /agent/v1/notifications/rules/:rule_id", async () => {
    const { fetch, calls } = mockFetch(() => json({ deleted: true, rule_id: "rule_1" }));
    const result = await sdk(fetch).admin.rules.delete("rule_1");
    assert.equal(calls[0]!.method, "DELETE");
    assert.equal(calls[0]!.url, "https://api.test/agent/v1/notifications/rules/rule_1");
    assert.equal(result.deleted, true);
    assert.equal(result.rule_id, "rule_1");
  });
});

describe("admin.testNotification — optional source/event_type override", () => {
  it("sends an empty body when no override is given", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        status: "queued",
        source_event_id: "0xabc:123",
        drained: { claimed: 0, delivered: 0, skipped: 0, failed_transient: 0, failed_permanent: 0 },
        telegram: { destinations: [] },
        note: "queued",
      }),
    );
    await sdk(fetch).admin.testNotification();
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {});
  });

  it("forwards source/event_type in snake_case and returns telegram.destinations", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        status: "delivered",
        source_event_id: "0xabc:123",
        drained: { claimed: 1, delivered: 1, skipped: 0, failed_transient: 0, failed_permanent: 0 },
        telegram: {
          destinations: [
            { binding_id: "bnd_1", label: "kychon alerts", delivered: true },
            { binding_id: "bnd_2", label: null, delivered: false, transient: false, description: "http_403" },
          ],
        },
        note: "delivered",
      }),
    );
    const result = await sdk(fetch).admin.testNotification({ source: "app", eventType: "signature_failed" });

    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      source: "app",
      event_type: "signature_failed",
    });
    assert.equal(result.telegram.destinations.length, 2);
    assert.equal(result.telegram.destinations[0]!.delivered, true);
    assert.equal(result.telegram.destinations[1]!.description, "http_403");
  });
});
