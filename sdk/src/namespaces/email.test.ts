/**
 * Unit tests for the `email` namespace. Locks the SDK's runtime shape against
 * what the gateway actually returns.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { LocalError } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function makeCreds(
  overrides: Partial<CredentialsProvider> = {},
): CredentialsProvider {
  return {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject(id: string) {
      if (id === "prj_known") {
        return {
          anon_key: "anon_xxx",
          service_key: "service_xxx",
          mailbox_id: "mbx_known",
        };
      }
      return null;
    },
    ...overrides,
  };
}

function makeSdk(
  creds: CredentialsProvider,
  fetchImpl: typeof globalThis.fetch,
): Run402 {
  return new Run402({
    apiBase: "https://api.example.test",
    credentials: creds,
    fetch: fetchImpl,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("email.createMailbox", () => {
  it("returns the full mailbox record with project_id, sends_today, unique_recipients, created_at, updated_at", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        mailbox_id: "mbx_abc",
        address: "qatest456@mail.run402.com",
        slug: "qatest456",
        project_id: "prj_known",
        status: "active",
        sends_today: 0,
        unique_recipients: 0,
        created_at: "2026-05-01T16:51:56.760Z",
        updated_at: "2026-05-01T16:51:56.760Z",
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.email.createMailbox("prj_known", "qatest456");

    assert.equal(calls[0]!.url, "https://api.example.test/mailboxes/v1");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(result.mailbox_id, "mbx_abc");
    assert.equal(result.address, "qatest456@mail.run402.com");
    assert.equal(result.slug, "qatest456");
    assert.equal(result.project_id, "prj_known");
    assert.equal(result.status, "active");
    assert.equal(result.sends_today, 0);
    assert.equal(result.unique_recipients, 0);
    assert.equal(result.created_at, "2026-05-01T16:51:56.760Z");
    assert.equal(result.updated_at, "2026-05-01T16:51:56.760Z");
  });
});

describe("email.getMailbox + listMailboxes wire shape", () => {
  it("getMailbox parses the canonical envelope { mailboxes: [...] }", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        mailboxes: [
          {
            mailbox_id: "mbx_envelope",
            address: "envelope@mail.run402.com",
            slug: "envelope",
            project_id: "prj_known",
            status: "active",
            sends_today: 1,
            unique_recipients: 1,
            created_at: "2026-05-01T00:00:00.000Z",
            updated_at: "2026-05-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const creds = makeCreds({
      async getProject() {
        return { anon_key: "a", service_key: "s" };
      },
    });
    const sdk = makeSdk(creds, fetch);
    const mb = await sdk.email.getMailbox("prj_known");

    assert.equal(calls[0]!.url, "https://api.example.test/mailboxes/v1");
    assert.equal(mb.mailbox_id, "mbx_envelope");
    assert.equal(mb.address, "envelope@mail.run402.com");
  });
});

describe("email.deleteMailbox", () => {
  it("returns the deleted record { mailbox_id, address }", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ mailbox_id: "mbx_known", address: "old@mail.run402.com" }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.email.deleteMailbox("prj_known");

    assert.equal(calls[0]!.url, "https://api.example.test/mailboxes/v1/mbx_known");
    assert.equal(calls[0]!.method, "DELETE");
    assert.equal(result.mailbox_id, "mbx_known");
    assert.equal(result.address, "old@mail.run402.com");
  });
});

describe("email.send", () => {
  it("returns { message_id, status, to, template, subject, sent_at }", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        message_id: "msg_1777660214904_erlta0",
        to: "user@example.invalid",
        template: null,
        subject: "test",
        status: "sent",
        sent_at: "2026-05-01T18:30:14.904Z",
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.email.send("prj_known", {
      to: "user@example.invalid",
      subject: "test",
      html: "<p>hi</p>",
    });

    assert.equal(calls[0]!.url, "https://api.example.test/mailboxes/v1/mbx_known/messages");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(result.message_id, "msg_1777660214904_erlta0");
    assert.equal(result.status, "sent");
    assert.equal(result.to, "user@example.invalid");
    assert.equal(result.template, null);
    assert.equal(result.subject, "test");
    assert.equal(result.sent_at, "2026-05-01T18:30:14.904Z");
  });
});

describe("email.list", () => {
  it("GETs mailbox messages with limit and after query params", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse([]));
    const sdk = makeSdk(makeCreds(), fetch);
    await sdk.email.list("prj_known", { limit: 1, after: "msg_prev" });

    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/mailboxes/v1/mbx_known/messages");
    assert.equal(url.searchParams.get("limit"), "1");
    assert.equal(url.searchParams.get("after"), "msg_prev");
  });

  it("throws LocalError and does not request for invalid limits", async () => {
    const invalidLimits = [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1];

    for (const limit of invalidLimits) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error(`unexpected fetch for limit ${String(limit)}`);
      });
      const sdk = makeSdk(makeCreds(), fetch);

      await assert.rejects(
        sdk.email.list("prj_known", { limit }),
        (err: unknown) =>
          err instanceof LocalError &&
          err.context === "listing emails" &&
          /limit.*positive safe integer/i.test(err.message),
      );
      assert.equal(calls.length, 0, `limit ${String(limit)} should not request`);
    }
  });
});
