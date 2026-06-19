import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402, TransferFreezeError, isTransferFreezeError } from "../index.js";
import type { CredentialsProvider } from "../credentials.js";

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function mockFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ?? null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeCreds(): CredentialsProvider {
  return {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject() {
      return null;
    },
  };
}

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  return new Run402({
    apiBase: "https://api.example.test",
    credentials: makeCreds(),
    fetch: fetchImpl,
  });
}

describe("admin.transfers.initiate (wallet)", () => {
  it("POSTs the gateway init route with snake_case body", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_abc/transfers");
      const body = JSON.parse(String(call.body));
      assert.deepEqual(body, {
        to_wallet: "0xBEEF",
        billing_policy: "migrate",
        message: "hi",
        kysigned_record_id: "ks_1",
      });
      return jsonResponse({
        transfer_id: "ptx_1",
        expires_at: "2026-05-30T00:00:00Z",
        project_summary: {
          project_id: "prj_abc",
          project_name: "demo",
          billing_policy: "migrate",
          from_wallet: "0xaaa",
          to_wallet: "0xbeef",
        },
        your_unused_lease_days: 30,
        lease_refundable: false,
        terms_sha256: "abc",
      }, 201);
    });

    const r = makeSdk(fetch);
    const res = await r.admin.transfers.initiate({
      projectId: "prj_abc",
      toWallet: "0xBEEF",
      billingPolicy: "migrate",
      message: "hi",
      kysignedRecordId: "ks_1",
    });
    assert.equal((res as { transfer_id: string }).transfer_id, "ptx_1");
    assert.equal((res as { lease_refundable: boolean }).lease_refundable, false);
    assert.equal(calls.length, 1);
  });

  it("omits optional fields when undefined", async () => {
    const { fetch } = mockFetch((call) => {
      const body = JSON.parse(String(call.body));
      assert.deepEqual(body, { to_wallet: "0xc0ffee" });
      return jsonResponse({
        transfer_id: "ptx_2",
        expires_at: "2026-05-30T00:00:00Z",
        project_summary: {
          project_id: "prj_abc",
          project_name: null,
          billing_policy: "migrate",
          from_wallet: "0xa",
          to_wallet: "0xc0ffee",
        },
        your_unused_lease_days: 0,
        lease_refundable: false,
        terms_sha256: "h",
      }, 201);
    });
    const r = makeSdk(fetch);
    await r.admin.transfers.initiate({ projectId: "prj_abc", toWallet: "0xc0ffee" });
  });

  it("rejects both-or-neither recipient locally (no request issued)", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const r = makeSdk(fetch);
    // Cast to any: the discriminated union makes "both" / "neither" compile errors;
    // we exercise the runtime guard that backstops JS callers.
    await assert.rejects(
      () => (r.admin.transfers.initiate as (i: unknown) => Promise<unknown>)({
        projectId: "prj_abc",
        toWallet: "0xbeef",
        toEmail: "a@b.c",
      }),
      (e: unknown) => (e as { code?: string }).code === "VALIDATION_ERROR",
    );
    await assert.rejects(
      () => (r.admin.transfers.initiate as (i: unknown) => Promise<unknown>)({
        projectId: "prj_abc",
        toEmail: "a@b.c",
        toOrgId: "11111111-1111-4111-8111-111111111111",
      }),
      (e: unknown) => (e as { code?: string }).code === "VALIDATION_ERROR",
    );
    await assert.rejects(
      () => (r.admin.transfers.initiate as (i: unknown) => Promise<unknown>)({ projectId: "prj_abc" }),
      (e: unknown) => (e as { code?: string }).code === "VALIDATION_ERROR",
    );
    assert.equal(calls.length, 0);
  });
});

describe("admin.transfers.initiate (org)", () => {
  it("POSTs /transfers with to_org_id and persists returned keys", async () => {
    const saved: Array<{ projectId: string; keys: { anon_key: string; service_key: string } }> = [];
    let activeProject: string | null = null;
    const credentials: CredentialsProvider = {
      async getAuth() {
        return { "SIGN-IN-WITH-X": "test-siwx" };
      },
      async getProject() {
        return null;
      },
      async saveProject(projectId, keys) {
        saved.push({ projectId, keys });
      },
      async setActiveProject(projectId) {
        activeProject = projectId;
      },
    };
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_abc/transfers");
      assert.deepEqual(JSON.parse(String(call.body)), {
        to_org_id: "11111111-1111-4111-8111-111111111111",
        message: "move it",
      });
      return jsonResponse({
        transfer_id: "ptx_org1",
        project_id: "prj_abc",
        from_organization_id: "00000000-0000-4000-8000-000000000001",
        to_organization_id: "11111111-1111-4111-8111-111111111111",
        completed_at: "2026-06-19T10:00:00Z",
        secrets_rotation_advised: true,
        secret_names_inherited: ["API_KEY"],
        secrets_count_inherited: 1,
        github_repo_note: "GitHub repository ownership is not transferred by Run402.",
        anon_key: "anon_moved",
        service_key: "svc_moved",
      }, 200);
    });
    const r = new Run402({
      apiBase: "https://api.example.test",
      credentials,
      fetch,
    });
    const res = await r.admin.transfers.initiate({
      projectId: "prj_abc",
      toOrgId: "11111111-1111-4111-8111-111111111111",
      message: "move it",
    });
    assert.equal(res.transfer_id, "ptx_org1");
    assert.equal(res.to_organization_id, "11111111-1111-4111-8111-111111111111");
    assert.deepEqual(saved, [
      {
        projectId: "prj_abc",
        keys: { anon_key: "anon_moved", service_key: "svc_moved" },
      },
    ]);
    assert.equal(activeProject, "prj_abc");
    assert.equal(calls.length, 1);
  });
});

describe("admin.transfers.initiate (email)", () => {
  it("POSTs /transfers with to_email (NOT /handoffs)", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_abc/transfers");
      assert.deepEqual(JSON.parse(String(call.body)), { to_email: "alice@example.com", message: "hi" });
      return jsonResponse(
        { status: "ok", transfer_id: "ptx_e1", to_email: "alice@example.com", expires_at: "2026-06-10T00:00:00Z" },
        201,
      );
    });
    const res = await makeSdk(fetch).admin.transfers.initiate({
      projectId: "prj_abc",
      toEmail: "alice@example.com",
      message: "hi",
    });
    assert.equal((res as { status: string }).status, "ok");
    assert.equal((res as { transfer_id: string }).transfer_id, "ptx_e1");
    assert.equal(calls.length, 1);
  });

  it("sends retain_collaborator only when set", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ status: "ok", transfer_id: "ptx_r1", to_email: "alice@example.com", expires_at: "x" }, 201),
    );
    await makeSdk(fetch).admin.transfers.initiate({
      projectId: "prj_abc",
      toEmail: "alice@example.com",
      retainCollaborator: { role: "developer" },
    });
    assert.deepEqual(JSON.parse(String(calls[0].body)), {
      to_email: "alice@example.com",
      retain_collaborator: { role: "developer" },
    });
  });

  it("omits retain_collaborator when not requested", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ status: "ok", transfer_id: "ptx_r2", to_email: "alice@example.com", expires_at: "x" }, 201),
    );
    await makeSdk(fetch).admin.transfers.initiate({ projectId: "prj_abc", toEmail: "alice@example.com" });
    const body = JSON.parse(String(calls[0].body));
    assert.deepEqual(body, { to_email: "alice@example.com" });
    assert.ok(!("retain_collaborator" in body));
  });
});

describe("admin.transfers.preview", () => {
  it("GETs the preview route and returns a wallet preview", async () => {
    const previewBody = {
      transfer_id: "ptx_1",
      project_id: "prj_abc",
      project_name_snapshot: "demo",
      status: "pending",
      recipient_kind: "wallet",
      from_wallet: "0xaaa",
      from_wallet_display: "0xaa…aaa",
      to_wallet: "0xbeef",
      to_wallet_display: "0xbe…eef",
      billing_policy: "migrate",
      message: null,
      initiated_at: "2026-05-27T00:00:00Z",
      expires_at: "2026-05-30T00:00:00Z",
      kysigned_record_id: null,
      terms_sha256: "abc",
      custom_domains: [],
      subdomains: [],
      functions: [],
      secret_names: ["DB_URL"],
      mailbox_summary: { count: 0, slugs_truncated: [] },
      ci_bindings_to_be_revoked: [],
      signers: [],
      github_repo_note: "GitHub repository ownership is not transferred by Run402.",
      billing_implications: {
        from_organization_id: "org_1",
        target_organization_id: null,
        tier: "hobby",
        secrets_count: 1,
        functions_count: 0,
        custom_domains_count: 0,
      },
    };
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "GET");
      assert.equal(call.url, "https://api.example.test/agent/v1/transfers/ptx_1");
      return jsonResponse(previewBody);
    });
    const r = makeSdk(fetch);
    const res = await r.admin.transfers.preview("ptx_1");
    assert.equal(res.transfer_id, "ptx_1");
    assert.equal(res.recipient_kind, "wallet");
    assert.deepEqual(res.secret_names, ["DB_URL"]);
  });

  it("surfaces recipient_kind and the retain_collaborator block on an email transfer", async () => {
    const block = {
      principal_id: "prn_sender",
      role: "developer" as const,
      sender_label: "Bob",
      scope: "organization",
      note: "stay on",
      accept_field: "accept_retained_collaborator",
    };
    const { fetch } = mockFetch(() =>
      jsonResponse({
        transfer_id: "ptx_e1",
        project_id: "prj_abc",
        project_name_snapshot: "demo",
        status: "pending",
        recipient_kind: "email",
        from_wallet: null,
        from_wallet_display: null,
        to_wallet: null,
        to_wallet_display: null,
        to_email: "alice@example.com",
        billing_policy: "migrate",
        message: null,
        initiated_at: "x",
        expires_at: "y",
        kysigned_record_id: null,
        terms_sha256: "h",
        custom_domains: [],
        subdomains: [],
        functions: [],
        secret_names: [],
        mailbox_summary: { count: 0, slugs_truncated: [] },
        ci_bindings_to_be_revoked: [],
        signers: [],
        github_repo_note: "n",
        billing_implications: {
          from_organization_id: "org_1",
          target_organization_id: null,
          tier: null,
          secrets_count: 0,
          functions_count: 0,
          custom_domains_count: 0,
        },
        retain_collaborator: block,
      }),
    );
    const res = await makeSdk(fetch).admin.transfers.preview("ptx_e1");
    assert.equal(res.recipient_kind, "email");
    assert.equal(res.to_email, "alice@example.com");
    assert.deepEqual(res.retain_collaborator, block);
  });
});

describe("admin.transfers.accept (wallet completion)", () => {
  it("POSTs the accept route with empty body", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, "https://api.example.test/agent/v1/transfers/ptx_1/accept");
      assert.equal(String(call.body), "{}");
      return jsonResponse({
        project_id: "prj_abc",
        from_wallet: "0xaaa",
        to_wallet: "0xbeef",
        new_organization_id: "org_2",
        completed_at: "2026-05-27T01:00:00Z",
        secrets_rotation_advised: true,
        secret_names_inherited: ["DB_URL"],
        secrets_count_inherited: 1,
        github_repo_note: "GitHub repository ownership is not transferred by Run402.",
      });
    });
    const r = makeSdk(fetch);
    const res = await r.admin.transfers.accept("ptx_1");
    assert.equal(res.secrets_rotation_advised, true);
    assert.deepEqual(res.secret_names_inherited, ["DB_URL"]);
    assert.equal(calls[0].method, "POST");
  });

  it("surfaces the new owner's project keys on the result (#428)", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({
        project_id: "prj_abc",
        from_wallet: "0xaaa",
        to_wallet: "0xbeef",
        completed_at: "2026-05-27T01:00:00Z",
        secrets_rotation_advised: false,
        anon_key: "anon_jwt",
        service_key: "svc_jwt",
      }),
    );
    const r = makeSdk(fetch);
    const res = await r.admin.transfers.accept("ptx_1");
    assert.equal(res.anon_key, "anon_jwt");
    assert.equal(res.service_key, "svc_jwt");
  });

  it("persists the returned keys via saveProject + setActiveProject", async () => {
    const saved: Array<{ id: string; keys: unknown }> = [];
    let activated: string | null = null;
    const creds: CredentialsProvider = {
      async getAuth() {
        return { "SIGN-IN-WITH-X": "test-siwx" };
      },
      async getProject() {
        return null;
      },
      async saveProject(id, keys) {
        saved.push({ id, keys });
      },
      async setActiveProject(id) {
        activated = id;
      },
    };
    const { fetch } = mockFetch(() =>
      jsonResponse({
        project_id: "prj_new",
        from_wallet: "0xaaa",
        to_wallet: "0xbeef",
        completed_at: "2026-05-27T01:00:00Z",
        secrets_rotation_advised: false,
        anon_key: "anon_jwt",
        service_key: "svc_jwt",
      }),
    );
    const r = new Run402({ apiBase: "https://api.example.test", credentials: creds, fetch });
    await r.admin.transfers.accept("ptx_new");
    assert.deepEqual(saved, [
      { id: "prj_new", keys: { anon_key: "anon_jwt", service_key: "svc_jwt" } },
    ]);
    assert.equal(activated, "prj_new");
  });

  it("does not throw when the provider lacks saveProject (sandbox)", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({
        project_id: "prj_abc",
        from_wallet: "0xaaa",
        to_wallet: "0xbeef",
        completed_at: "2026-05-27T01:00:00Z",
        secrets_rotation_advised: false,
        anon_key: "anon_jwt",
        service_key: "svc_jwt",
      }),
    );
    const r = makeSdk(fetch);
    const res = await r.admin.transfers.accept("ptx_1");
    assert.equal(res.service_key, "svc_jwt");
  });
});

describe("admin.transfers.claim (email completion)", () => {
  it("POSTs /agent/v1/transfers/:id/claim with org_id when given, {} otherwise", async () => {
    const r1 = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/agent/v1/transfers/ptx_e1/claim");
      assert.deepEqual(JSON.parse(String(call.body)), { org_id: "org_9" });
      return jsonResponse({
        status: "accepted",
        project_id: "prj_abc",
        to_organization_id: "org_9",
        created_new_org: false,
        retained_collaborator_principal_id: null,
      });
    });
    const res = await makeSdk(r1.fetch).admin.transfers.claim("ptx_e1", { organizationId: "org_9" });
    assert.equal(res.status, "accepted");
    assert.equal(res.to_organization_id, "org_9");

    const r2 = mockFetch((call) => {
      assert.deepEqual(JSON.parse(String(call.body)), {});
      return jsonResponse({
        status: "accepted",
        project_id: "prj_abc",
        to_organization_id: "org_new",
        created_new_org: true,
        retained_collaborator_principal_id: null,
      });
    });
    const res2 = await makeSdk(r2.fetch).admin.transfers.claim("ptx_e1");
    assert.equal(res2.created_new_org, true);
  });

  it("surfaces and persists the new owner's keys via saveProject + setActiveProject (symmetric with accept)", async () => {
    const saved: Array<{ id: string; keys: unknown }> = [];
    let activated: string | null = null;
    const creds: CredentialsProvider = {
      async getAuth() {
        return { "SIGN-IN-WITH-X": "t" };
      },
      async getProject() {
        return null;
      },
      async saveProject(id, keys) {
        saved.push({ id, keys });
      },
      async setActiveProject(id) {
        activated = id;
      },
    };
    const { fetch } = mockFetch(() =>
      jsonResponse({
        status: "accepted",
        project_id: "prj_new",
        to_organization_id: "org_1",
        created_new_org: false,
        retained_collaborator_principal_id: null,
        anon_key: "anon_jwt",
        service_key: "svc_jwt",
      }),
    );
    const r = new Run402({ apiBase: "https://api.example.test", credentials: creds, fetch });
    const res = await r.admin.transfers.claim("ptx_e1");
    assert.equal(res.anon_key, "anon_jwt");
    assert.equal(res.service_key, "svc_jwt");
    assert.deepEqual(saved, [{ id: "prj_new", keys: { anon_key: "anon_jwt", service_key: "svc_jwt" } }]);
    assert.equal(activated, "prj_new");
  });

  it("does not throw when the provider lacks saveProject (sandbox)", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({
        status: "accepted",
        project_id: "prj_abc",
        to_organization_id: "org_1",
        created_new_org: false,
        retained_collaborator_principal_id: null,
        anon_key: "anon_jwt",
        service_key: "svc_jwt",
      }),
    );
    const res = await makeSdk(fetch).admin.transfers.claim("ptx_e1");
    assert.equal(res.service_key, "svc_jwt");
  });

  it("sends accept_retained_collaborator only when true and surfaces the retained principal", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        status: "accepted",
        project_id: "prj_abc",
        to_organization_id: "org_1",
        created_new_org: false,
        retained_collaborator_principal_id: "prn_sender",
      }),
    );
    const res = await makeSdk(fetch).admin.transfers.claim("ptx_r1", {
      organizationId: "org_1",
      acceptRetainedCollaborator: true,
    });
    assert.deepEqual(JSON.parse(String(calls[0].body)), {
      org_id: "org_1",
      accept_retained_collaborator: true,
    });
    assert.equal(res.retained_collaborator_principal_id, "prn_sender");
  });

  it("omits accept_retained_collaborator by default (full severance)", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        status: "accepted",
        project_id: "prj_abc",
        to_organization_id: "org_1",
        created_new_org: false,
        retained_collaborator_principal_id: null,
      }),
    );
    await makeSdk(fetch).admin.transfers.claim("ptx_r2");
    const body = JSON.parse(String(calls[0].body));
    assert.deepEqual(body, {});
    assert.ok(!("accept_retained_collaborator" in body));
  });
});

describe("admin.transfers.cancel", () => {
  it("POSTs the cancel route with reason when supplied", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/agent/v1/transfers/ptx_1/cancel");
      assert.deepEqual(JSON.parse(String(call.body)), { reason: "changed mind" });
      return jsonResponse({
        transfer_id: "ptx_1",
        status: "cancelled",
        cancelled_by: "from_wallet",
        cancellation_reason: "changed mind",
        cancelled_at: "2026-05-27T02:00:00Z",
      });
    });
    const r = makeSdk(fetch);
    const res = await r.admin.transfers.cancel("ptx_1", "changed mind");
    assert.equal(res.status, "cancelled");
    assert.equal(res.cancelled_by, "from_wallet");
  });

  it("omits reason from body when not supplied", async () => {
    const { fetch } = mockFetch((call) => {
      assert.deepEqual(JSON.parse(String(call.body)), {});
      return jsonResponse({
        transfer_id: "ptx_1",
        status: "cancelled",
        cancelled_by: "from_wallet",
        cancellation_reason: null,
        cancelled_at: "2026-05-27T02:00:00Z",
      });
    });
    const r = makeSdk(fetch);
    await r.admin.transfers.cancel("ptx_1");
  });
});

describe("admin.transfers.listIncoming / listOutgoing", () => {
  it("returns the kind-agnostic union (wallet + email rows, each tagged recipient_kind)", async () => {
    const body = {
      transfers: [
        {
          transfer_id: "ptx_1",
          project_id: "prj_abc",
          project_name_snapshot: "demo",
          recipient_kind: "wallet" as const,
          from_wallet: "0xaaa",
          to_wallet: "0xbeef",
          billing_policy: "migrate" as const,
          message: null,
          expires_at: "2026-05-30T00:00:00Z",
          preview_path: "/agent/v1/transfers/ptx_1",
        },
        {
          transfer_id: "ptx_e1",
          project_id: "prj_def",
          project_name_snapshot: "email-demo",
          recipient_kind: "email" as const,
          to_email: "alice@example.com",
          from_organization_id: "org_1",
          billing_policy: "migrate" as const,
          message: null,
          expires_at: "2026-06-10T00:00:00Z",
          preview_path: "/agent/v1/transfers/ptx_e1",
        },
      ],
    };
    const { fetch } = mockFetch((call) => {
      if (call.url.includes("/incoming")) return jsonResponse({ ...body, has_more: true, next_cursor: "cur_1" });
      return jsonResponse({ transfers: [], has_more: false, next_cursor: null });
    });
    const r = makeSdk(fetch);
    const incoming = await r.admin.transfers.listIncoming();
    assert.equal(incoming.transfers.length, 2);
    assert.equal(incoming.transfers[0].recipient_kind, "wallet");
    assert.equal(incoming.transfers[1].recipient_kind, "email");
    assert.equal(incoming.transfers[1].to_email, "alice@example.com");
    assert.equal(incoming.transfers[0].preview_path, "/agent/v1/transfers/ptx_1");
    assert.equal(incoming.has_more, true);
    assert.equal(incoming.next_cursor, "cur_1");
    const outgoing = await r.admin.transfers.listOutgoing();
    assert.deepEqual(outgoing.transfers, []);
    assert.equal(outgoing.has_more, false);
    assert.equal(outgoing.next_cursor, null);
  });

  it("threads limit/after onto the query string", async () => {
    const seen: string[] = [];
    const { fetch } = mockFetch((call) => {
      seen.push(call.url);
      return jsonResponse({ transfers: [], has_more: false, next_cursor: null });
    });
    const r = makeSdk(fetch);
    await r.admin.transfers.listIncoming({ limit: 10, after: "cur_20" });
    assert.equal(seen[0], "https://api.example.test/agent/v1/transfers/incoming?limit=10&after=cur_20");
    await r.admin.transfers.listOutgoing({ limit: 5 });
    assert.equal(seen[1], "https://api.example.test/agent/v1/transfers/outgoing?limit=5");
  });
});

describe("TransferFreezeError", () => {
  it("is thrown by the kernel on 409 PROJECT_HAS_PENDING_TRANSFER from an owner-mutating endpoint", async () => {
    const envelope = {
      code: "PROJECT_HAS_PENDING_TRANSFER",
      category: "validation",
      retryable: false,
      safe_to_retry: false,
      mutation_state: "none",
      message: "This project has a pending transfer.",
      details: { project_id: "prj_abc", transfer_id: "ptx_1" },
      next_actions: [
        {
          type: "cancel_transfer",
          method: "POST",
          path: "/agent/v1/transfers/ptx_1/cancel",
          auth: "siwx",
          why: "Cancel the pending transfer.",
        },
        {
          type: "view_transfer",
          method: "GET",
          path: "/agent/v1/transfers/ptx_1",
          auth: "siwx",
          why: "View the preview.",
        },
      ],
    };
    const { fetch } = mockFetch(() => jsonResponse(envelope, 409));

    const r = makeSdk(fetch);
    try {
      await r.admin.transfers.initiate({ projectId: "prj_abc", toWallet: "0xbeef" });
      assert.fail("expected TransferFreezeError");
    } catch (err) {
      assert.ok(isTransferFreezeError(err), "expected TransferFreezeError type-guard hit");
      const e = err as TransferFreezeError;
      assert.equal(e.kind, "transfer_freeze");
      assert.equal(e.status, 409);
      assert.equal(e.code, "PROJECT_HAS_PENDING_TRANSFER");
      assert.equal(e.transferId, "ptx_1");
      assert.equal(e.projectId, "prj_abc");
      assert.equal(e.cancelPath, "/agent/v1/transfers/ptx_1/cancel");
      assert.equal(e.previewPath, "/agent/v1/transfers/ptx_1");
    }
  });

  it("survives missing next_actions and details (still classifies)", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({ code: "PROJECT_HAS_PENDING_TRANSFER", message: "frozen" }, 409),
    );
    const r = makeSdk(fetch);
    try {
      await r.admin.transfers.cancel("ptx_x");
      assert.fail("expected TransferFreezeError");
    } catch (err) {
      assert.ok(isTransferFreezeError(err));
      const e = err as TransferFreezeError;
      assert.equal(e.transferId, null);
      assert.equal(e.cancelPath, null);
      assert.equal(e.previewPath, null);
    }
  });

  it("does NOT classify a generic 409 (different code) as TransferFreezeError", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({ code: "PENDING_TRANSFER_EXISTS", message: "single-pending invariant" }, 409),
    );
    const r = makeSdk(fetch);
    try {
      await r.admin.transfers.initiate({ projectId: "prj_abc", toWallet: "0xbeef" });
      assert.fail("expected an ApiError");
    } catch (err) {
      assert.equal(isTransferFreezeError(err), false);
    }
  });
});
