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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function projectDomain(overrides: Record<string, unknown> = {}) {
  return {
    project_id: "prj_visible",
    domain: "kysigned.com",
    status: "action_required",
    desired: {},
    observed: {},
    effective: {},
    authority: { recommended_mode: "manual_dns", options: [] },
    dns_records: [],
    checks: [],
    next_action: null,
    alternate_actions: [],
    provenance: {
      project: "server_control_plane",
      desired: "server_control_plane",
      observed_dns: "public_dns_resolvers",
      effective: "run402_control_plane",
      local_cache: "not_used",
    },
    ...overrides,
  };
}

function mockFetch(handler: (call: FetchCall) => Response): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
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

function makeSdk(credentials: CredentialsProvider, fetch: typeof globalThis.fetch): Run402 {
  return new Run402({
    apiBase: "https://api.example.test",
    credentials,
    fetch,
  });
}

function principalCreds(): CredentialsProvider {
  return {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProjectCredentials(id) {
      throw new Error(`unexpected local project credential lookup for ${id}`);
    },
  };
}

describe("ProjectDomain SDK", () => {
  it("ensures desired state through the project-scoped control-plane route", async () => {
    const desired = {
      email: {
        send: { enabled: true },
        receive: { enabled: true, strategy: "auto" as const },
        mailbox_addresses: {
          mode: "primary" as const,
          addresses: [{ local_part: "info", mailbox_slug: "info", create_mailbox: true }],
        },
      },
    };
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_visible/domains/kysigned.com");
      assert.equal(call.method, "PUT");
      assert.equal(call.headers["SIGN-IN-WITH-X"], "test-siwx");
      assert.equal(call.headers.Authorization, undefined);
      assert.deepEqual(JSON.parse(call.body as string), { desired });
      return jsonResponse(projectDomain({ desired }));
    });

    const sdk = makeSdk(principalCreds(), fetch);
    const result = await sdk.domains.ensure("prj_visible", "kysigned.com", { desired });
    assert.equal(result.provenance.local_cache, "not_used");
    assert.equal(calls.length, 1);
  });

  it("lists and checks domains without local project credential lookup", async () => {
    const { fetch, calls } = mockFetch((call) => {
      if (call.url.endsWith("/projects/v1/prj_visible/domains")) {
        return jsonResponse({ domains: [projectDomain()] });
      }
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_visible/domains/kysigned.com/actions/check");
      assert.equal(call.method, "POST");
      return jsonResponse(projectDomain({ status: "active" }));
    });

    const sdk = makeSdk(principalCreds(), fetch);
    assert.equal((await sdk.domains.list("prj_visible")).domains[0]!.domain, "kysigned.com");
    assert.equal((await sdk.domains.check("prj_visible", "kysigned.com")).status, "active");
    assert.equal(calls.length, 2);
  });

  it("creates receive tests and preserves the receive_test payload", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_visible/domains/kysigned.com/actions/test_receive");
      assert.equal(call.method, "POST");
      assert.deepEqual(JSON.parse(call.body as string), { to: "info" });
      return jsonResponse({
        ...projectDomain(),
        receive_test: {
          id: "pdrt_1",
          local_part: "info",
          address: "info@kysigned.com",
          target_managed_address: "info@kysigned.mail.run402.com",
          token: "rt_aaaaaaaaaaaaaaaaaaaaaaaa",
          status: "pending",
          created_at: "2026-07-03T00:00:00Z",
        },
      }, 201);
    });

    const sdk = makeSdk(principalCreds(), fetch);
    const result = await sdk.domains.testReceive("prj_visible", "kysigned.com", "info");
    assert.equal(result.receive_test.token, "rt_aaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("wait polls check until the requested state is satisfied", async () => {
    let count = 0;
    const { fetch, calls } = mockFetch(() => {
      count += 1;
      return jsonResponse(projectDomain({
        status: count === 1 ? "waiting" : "active",
        checks: count === 1 ? [{ id: "email.receive.route", status: "pending", blocking: true }] : [],
      }));
    });

    const sdk = makeSdk(principalCreds(), fetch);
    const result = await sdk.domains.wait("prj_visible", "kysigned.com", {
      timeoutMs: 1_000,
      intervalMs: 1,
    });
    assert.equal(result.status, "active");
    assert.equal(calls.length, 2);
  });

  it("old domains.add fails with COMMAND_REMOVED and a replacement command", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(principalCreds(), fetch);

    await assert.rejects(
      () => sdk.domains.add("prj_visible", { domain: "kysigned.com", subdomainName: "app" }),
      (err) => {
        assert.ok(err instanceof LocalError);
        assert.equal(err.code, "COMMAND_REMOVED");
        assert.equal((err.details as { replacement?: string }).replacement, "run402 domains connect kysigned.com --project prj_visible --web");
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });
});
