/**
 * Unit tests for `r.operator.session.*` — the hosted control-plane session
 * client surface (gateway v1.78). Mocked fetch: assert URL / method / body and
 * the auth-header selection that mirrors `operator.overview` — public mint
 * methods send NO auth (the body/link token is the credential); session-bound
 * methods send the `control_plane_session` bearer when `token` is passed and
 * fall back to the credential provider (SIWX) when it is omitted.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
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

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  const creds: CredentialsProvider = {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject() {
      return null;
    },
  };
  return new Run402({ apiBase: "https://api.example.test", credentials: creds, fetch: fetchImpl });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SESSION = {
  control_plane_session_token: "cps_tok",
  token_type: "Bearer",
  expires_in: 900,
  principal_id: "prn_1",
  amr: ["email"],
};

describe("operator.session — public mint methods (no auth)", () => {
  it("email POSTs {email} unauthenticated (non-enumerating)", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ status: "ok", message: "If that email can sign in, a link is on its way." }),
    );
    const res = await makeSdk(fetch).operator.session.email({ email: "a@b.com" });

    assert.equal(calls[0]!.url, "https://api.example.test/agent/v1/control-plane/session/email");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
    assert.equal(calls[0]!.headers["Authorization"], undefined);
    assert.deepEqual(JSON.parse(String(calls[0]!.body)), { email: "a@b.com" });
    assert.equal(res.status, "ok");
  });

  it("verifyEmail POSTs {token} → session (no auth)", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(SESSION));
    const res = await makeSdk(fetch).operator.session.verifyEmail({ token: "ml_tok" });

    assert.equal(calls[0]!.url, "https://api.example.test/agent/v1/control-plane/session/email/verify");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
    assert.deepEqual(JSON.parse(String(calls[0]!.body)), { token: "ml_tok" });
    assert.equal(res.control_plane_session_token, "cps_tok");
    assert.deepEqual(res.amr, ["email"]);
  });

  it("passkeyOptions / passkeyVerify hit the login endpoints unauthenticated", async () => {
    const { fetch, calls } = mockFetch((c) =>
      c.url.endsWith("/options") ? jsonResponse({ options: { challenge: "x" } }) : jsonResponse(SESSION),
    );
    const sdk = makeSdk(fetch);
    const opts = await sdk.operator.session.passkeyOptions({ email: "a@b.com" });
    const verified = await sdk.operator.session.passkeyVerify({ email: "a@b.com", response: { id: "cred" } });

    assert.equal(calls[0]!.url, "https://api.example.test/agent/v1/control-plane/session/passkey/options");
    assert.equal(calls[1]!.url, "https://api.example.test/agent/v1/control-plane/session/passkey/verify");
    assert.equal(calls[1]!.headers["SIGN-IN-WITH-X"], undefined);
    assert.deepEqual(JSON.parse(String(calls[1]!.body)), { email: "a@b.com", response: { id: "cred" } });
    assert.deepEqual((opts.options as { challenge: string }).challenge, "x");
    assert.equal(verified.control_plane_session_token, "cps_tok");
  });

  it("oauthUrl builds the provider start URL with no network", () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const url = makeSdk(fetch).operator.session.oauthUrl("google");
    assert.equal(calls.length, 0);
    assert.equal(url, "https://api.example.test/agent/v1/control-plane/oauth/google/start");
  });

  it("consumeRecoveryCode POSTs {code} → session + must_enroll_passkey", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ ...SESSION, amr: ["recovery_code"], must_enroll_passkey: true }),
    );
    const res = await makeSdk(fetch).operator.session.consumeRecoveryCode({ code: "abc-123" });

    assert.equal(calls[0]!.url, "https://api.example.test/agent/v1/control-plane/recovery/consume");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
    assert.deepEqual(JSON.parse(String(calls[0]!.body)), { code: "abc-123" });
    assert.equal(res.must_enroll_passkey, true);
  });
});

describe("operator.session — session-bound methods (bearer vs SIWX fallback)", () => {
  it("whoami with a token: bearer, no SIWX; returns principal + memberships", async () => {
    const who = {
      principal: { id: "prn_1", type: "human", createdAt: "2026-01-01T00:00:00Z" },
      memberships: [{ organization_id: "org_1", role: "developer", status: "active" }],
      amr: ["passkey"],
      amr_times: { passkey: 1 },
    };
    const { fetch, calls } = mockFetch(() => jsonResponse(who));
    const res = await makeSdk(fetch).operator.session.whoami({ token: "cps_tok" });

    assert.equal(calls[0]!.url, "https://api.example.test/agent/v1/control-plane/session");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer cps_tok");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
    assert.equal(res.principal.id, "prn_1");
    assert.equal(res.memberships[0]!.organization_id, "org_1");
  });

  it("whoami without a token: falls back to SIWX (credential provider)", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ principal: { id: "p", type: "human", createdAt: "x" }, memberships: [], amr: [] }),
    );
    await makeSdk(fetch).operator.session.whoami();
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.equal(calls[0]!.headers["Authorization"], undefined);
  });

  it("refresh + revoke POST with the bearer", async () => {
    const { fetch, calls } = mockFetch((c) =>
      c.url.endsWith("/refresh")
        ? jsonResponse({ control_plane_session_token: "cps_tok2", token_type: "Bearer", expires_in: 900 })
        : jsonResponse({ status: "revoked" }),
    );
    const sdk = makeSdk(fetch);
    const refreshed = await sdk.operator.session.refresh({ token: "cps_tok" });
    const revoked = await sdk.operator.session.revoke({ token: "cps_tok" });

    assert.equal(calls[0]!.url, "https://api.example.test/agent/v1/control-plane/session/refresh");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer cps_tok");
    assert.equal(refreshed.control_plane_session_token, "cps_tok2");
    assert.equal(calls[1]!.url, "https://api.example.test/agent/v1/control-plane/session/revoke");
    assert.equal(revoked.status, "revoked");
  });

  it("enrollPasskeyVerify sends {response,label} with the bearer", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ status: "ok", credential_id: "cred_1" }, 201));
    const res = await makeSdk(fetch).operator.session.enrollPasskeyVerify({
      token: "cps_tok",
      response: { id: "x" },
      label: "My Laptop",
    });
    assert.equal(calls[0]!.url, "https://api.example.test/agent/v1/control-plane/passkey/enroll/verify");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer cps_tok");
    assert.deepEqual(JSON.parse(String(calls[0]!.body)), { response: { id: "x" }, label: "My Laptop" });
    assert.equal(res.credential_id, "cred_1");
  });

  it("stepUpOptions sends {op_class}; stepUpVerify maps camel→snake fields", async () => {
    const { fetch, calls } = mockFetch((c) =>
      c.url.endsWith("/options") ? jsonResponse({ options: {} }) : jsonResponse({ status: "ok", stepped_up: true }),
    );
    const sdk = makeSdk(fetch);
    await sdk.operator.session.stepUpOptions({ token: "cps_tok", opClass: "org.invite" });
    const verified = await sdk.operator.session.stepUpVerify({
      token: "cps_tok",
      response: { id: "x" },
      opClass: "org.invite",
      objectKind: "organization",
      objectId: "org_1",
    });
    assert.equal(calls[0]!.url, "https://api.example.test/agent/v1/control-plane/step-up/options");
    assert.deepEqual(JSON.parse(String(calls[0]!.body)), { op_class: "org.invite" });
    assert.deepEqual(JSON.parse(String(calls[1]!.body)), {
      response: { id: "x" },
      op_class: "org.invite",
      object_kind: "organization",
      object_id: "org_1",
    });
    assert.equal(verified.stepped_up, true);
  });

  it("issueRecoveryCodes returns the one-time codes", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({ status: "ok", recovery_codes: ["c1", "c2"], note: "once" }, 201),
    );
    const res = await makeSdk(fetch).operator.session.issueRecoveryCodes({ token: "cps_tok" });
    assert.deepEqual(res.recovery_codes, ["c1", "c2"]);
  });

  it("listAuthenticators unwraps {authenticators}; revokeAuthenticator DELETEs by id", async () => {
    const { fetch, calls } = mockFetch((c) =>
      c.method === "GET"
        ? jsonResponse({ authenticators: [{ id: "auth_1", kind: "webauthn" }] })
        : jsonResponse({ status: "revoked", kind: "webauthn" }),
    );
    const sdk = makeSdk(fetch);
    const list = await sdk.operator.session.listAuthenticators({ token: "cps_tok" });
    const revoked = await sdk.operator.session.revokeAuthenticator({ token: "cps_tok", id: "auth_1" });

    assert.equal(calls[0]!.url, "https://api.example.test/agent/v1/control-plane/authenticators");
    assert.deepEqual(list, [{ id: "auth_1", kind: "webauthn" }]);
    assert.equal(calls[1]!.url, "https://api.example.test/agent/v1/control-plane/authenticators/auth_1");
    assert.equal(calls[1]!.method, "DELETE");
    assert.equal(revoked.kind, "webauthn");
  });
});
