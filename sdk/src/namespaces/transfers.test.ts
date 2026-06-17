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

describe("admin.transfers.initiate", () => {
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
    assert.equal(res.transfer_id, "ptx_1");
    assert.equal(res.lease_refundable, false);
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
});

describe("admin.transfers.preview", () => {
  it("GETs the preview route and returns the preview document", async () => {
    const previewBody = {
      transfer_id: "ptx_1",
      project_id: "prj_abc",
      project_name_snapshot: "demo",
      status: "pending",
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
    assert.deepEqual(res.secret_names, ["DB_URL"]);
  });
});

describe("admin.transfers.accept", () => {
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
    // The default provider implements neither saveProject nor setActiveProject —
    // accept must still return the keys without throwing.
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
  it("returns the transfers array (unwrapped from the envelope)", async () => {
    const body = {
      transfers: [
        {
          transfer_id: "ptx_1",
          project_id: "prj_abc",
          project_name_snapshot: "demo",
          from_wallet: "0xaaa",
          to_wallet: "0xbeef",
          billing_policy: "migrate" as const,
          message: null,
          initiated_at: "2026-05-27T00:00:00Z",
          expires_at: "2026-05-30T00:00:00Z",
          kysigned_record_id: null,
          preview_path: "/agent/v1/transfers/ptx_1",
        },
      ],
    };
    const { fetch } = mockFetch((call) => {
      if (call.url.includes("/incoming")) return jsonResponse(body);
      return jsonResponse({ transfers: [] });
    });
    const r = makeSdk(fetch);
    const incoming = await r.admin.transfers.listIncoming();
    assert.equal(incoming.length, 1);
    assert.equal(incoming[0].transfer_id, "ptx_1");
    assert.equal(incoming[0].preview_path, "/agent/v1/transfers/ptx_1");
    const outgoing = await r.admin.transfers.listOutgoing();
    assert.deepEqual(outgoing, []);
  });

  it("threads limit/offset onto the query string", async () => {
    const seen: string[] = [];
    const { fetch } = mockFetch((call) => {
      seen.push(call.url);
      return jsonResponse({ transfers: [] });
    });
    const r = makeSdk(fetch);
    await r.admin.transfers.listIncoming({ limit: 10, offset: 20 });
    assert.equal(seen[0], "https://api.example.test/agent/v1/transfers/incoming?limit=10&offset=20");
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

describe("admin.transfers — email->org handoff (v1.78)", () => {
  it("initiateHandoff POSTs /handoffs with snake_case to_email", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_abc/handoffs");
      assert.deepEqual(JSON.parse(String(call.body)), { to_email: "x@y.z", message: "hi" });
      return jsonResponse({ transfer_id: "hof_1", expires_at: "2026-06-10T00:00:00Z" });
    });
    const res = await makeSdk(fetch).admin.transfers.initiateHandoff({
      projectId: "prj_abc",
      toEmail: "x@y.z",
      message: "hi",
    });
    assert.equal(res.transfer_id, "hof_1");
    assert.equal(calls.length, 1);
  });

  it("listIncomingHandoffs unwraps { handoffs }, falls back to { transfers } then []", async () => {
    const r1 = makeSdk(mockFetch(() => jsonResponse({ handoffs: [{ transfer_id: "hof_1", project_id: "prj_abc" }] })).fetch);
    assert.equal((await r1.admin.transfers.listIncomingHandoffs())[0].transfer_id, "hof_1");
    const r2 = makeSdk(mockFetch(() => jsonResponse({ transfers: [{ transfer_id: "hof_2", project_id: "prj_x" }] })).fetch);
    assert.equal((await r2.admin.transfers.listIncomingHandoffs())[0].transfer_id, "hof_2");
    const r3 = makeSdk(mockFetch(() => jsonResponse({})).fetch);
    assert.deepEqual(await r3.admin.transfers.listIncomingHandoffs(), []);
  });

  it("previewHandoff GETs /agent/v1/handoffs/:id", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ transfer_id: "hof_1", project_id: "prj_abc", status: "pending" }),
    );
    const p = await makeSdk(fetch).admin.transfers.previewHandoff("hof_1");
    assert.equal(calls[0].url, "https://api.example.test/agent/v1/handoffs/hof_1");
    assert.equal(p.project_id, "prj_abc");
  });

  it("claimHandoff POSTs /claim with organization_id when given, {} otherwise", async () => {
    const r1 = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/agent/v1/handoffs/hof_1/claim");
      assert.deepEqual(JSON.parse(String(call.body)), { organization_id: "org_9" });
      return jsonResponse({ project_id: "prj_abc", new_organization_id: "org_9" });
    });
    await makeSdk(r1.fetch).admin.transfers.claimHandoff("hof_1", { organizationId: "org_9" });

    const r2 = mockFetch((call) => {
      assert.deepEqual(JSON.parse(String(call.body)), {});
      return jsonResponse({ project_id: "prj_abc", new_organization_id: "org_new" });
    });
    const res = await makeSdk(r2.fetch).admin.transfers.claimHandoff("hof_1");
    assert.equal(res.new_organization_id, "org_new");
  });

  it("cancelHandoff POSTs /agent/v1/handoffs/:id/cancel", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ transfer_id: "hof_1", status: "cancelled", cancelled_by: "from_wallet", cancellation_reason: null, cancelled_at: "2026-06-08T00:00:00Z" }),
    );
    await makeSdk(fetch).admin.transfers.cancelHandoff("hof_1");
    assert.equal(calls[0].url, "https://api.example.test/agent/v1/handoffs/hof_1/cancel");
    assert.equal(calls[0].method, "POST");
  });
});

describe("admin.transfers handoff retain-collaborator (v1.91)", () => {
  it("initiateHandoff sends retain_collaborator only when set", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ transfer_id: "hof_r1" }));
    await makeSdk(fetch).admin.transfers.initiateHandoff({
      projectId: "prj_abc",
      toEmail: "alice@example.com",
      retainCollaborator: { role: "developer" },
    });
    assert.equal(calls[0].url, "https://api.example.test/projects/v1/prj_abc/handoffs");
    assert.deepEqual(JSON.parse(String(calls[0].body)), {
      to_email: "alice@example.com",
      retain_collaborator: { role: "developer" },
    });
  });

  it("initiateHandoff omits retain_collaborator when not requested", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ transfer_id: "hof_r2" }));
    await makeSdk(fetch).admin.transfers.initiateHandoff({ projectId: "prj_abc", toEmail: "alice@example.com" });
    const body = JSON.parse(String(calls[0].body));
    assert.deepEqual(body, { to_email: "alice@example.com" });
    assert.ok(!("retain_collaborator" in body));
  });

  it("claimHandoff sends accept_retained_collaborator only when true and surfaces the result id", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ project_id: "prj_abc", retained_collaborator_principal_id: "prn_sender" }),
    );
    const res = await makeSdk(fetch).admin.transfers.claimHandoff("hof_r1", {
      organizationId: "org_1",
      acceptRetainedCollaborator: true,
    });
    assert.equal(calls[0].url, "https://api.example.test/agent/v1/handoffs/hof_r1/claim");
    assert.deepEqual(JSON.parse(String(calls[0].body)), {
      organization_id: "org_1",
      accept_retained_collaborator: true,
    });
    assert.equal(res.retained_collaborator_principal_id, "prn_sender");
  });

  it("claimHandoff omits accept_retained_collaborator by default (full severance)", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ project_id: "prj_abc" }));
    await makeSdk(fetch).admin.transfers.claimHandoff("hof_r2");
    const body = JSON.parse(String(calls[0].body));
    assert.deepEqual(body, {});
    assert.ok(!("accept_retained_collaborator" in body));
  });

  it("previewHandoff surfaces the typed retain_collaborator block", async () => {
    const block = {
      principal_id: "prn_sender",
      role: "developer",
      sender_label: "Bob",
      scope: "organization",
      note: "stay on",
      accept_field: "accept_retained_collaborator",
    };
    const { fetch } = mockFetch(() =>
      jsonResponse({ transfer_id: "hof_r1", project_id: "prj_abc", status: "pending", retain_collaborator: block }),
    );
    const res = await makeSdk(fetch).admin.transfers.previewHandoff("hof_r1");
    assert.deepEqual(res.retain_collaborator, block);
  });
});
