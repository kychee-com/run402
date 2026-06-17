/**
 * Unit tests for the `operator` namespace. Contract-first: the device + revoke
 * endpoints (kychee-com/run402-private#443) 404 against the live gateway until
 * that ships, so these exercise the client against mocked fetch — URL, method,
 * auth header selection (bearer vs SIWX vs none), and the RFC 8628 poll state
 * machine (pending/slow_down are data, not exceptions).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { isOperatorApprovalRequired } from "../errors.js";
import type { OperatorApprovalRequiredError } from "../errors.js";
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

function makeCreds(overrides: Partial<CredentialsProvider> = {}): CredentialsProvider {
  return {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject() {
      return null;
    },
    ...overrides,
  };
}

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  return new Run402({
    apiBase: "https://api.example.test",
    credentials: makeCreds(),
    fetch: fetchImpl,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TOKEN_PAYLOAD = {
  operator_session_token: "ops_tok.abc.def",
  token_type: "Bearer",
  expires_in: 1800,
  absolute_expires_at: "2099-01-01T00:00:00.000Z",
  email: "tal@kychee.com",
  wallets: ["0xabc"],
};

describe("operator.deviceStart", () => {
  it("POSTs the device endpoint unauthenticated (no SIWX header)", async () => {
    const start = {
      device_code: "dc_secret",
      user_code: "WXYZ-1234",
      verification_uri: "https://api.example.test/operator",
      verification_uri_complete: "https://api.example.test/operator?code=WXYZ-1234",
      expires_in: 600,
      interval: 5,
    };
    const { fetch, calls } = mockFetch(() => jsonResponse(start));
    const sdk = makeSdk(fetch);
    const result = await sdk.operator.deviceStart();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/agent/v1/operator/session/device");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
    assert.equal(result.user_code, "WXYZ-1234");
    assert.equal(result.interval, 5);
  });
});

describe("operator.devicePoll", () => {
  it("returns {kind:'approved'} with the session on 200 + token", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(TOKEN_PAYLOAD));
    const sdk = makeSdk(fetch);
    const result = await sdk.operator.devicePoll("dc_secret");

    assert.equal(calls[0]!.url, "https://api.example.test/agent/v1/operator/session/device/token");
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]!.body)), { device_code: "dc_secret" });
    assert.equal(result.kind, "approved");
    if (result.kind === "approved") {
      assert.equal(result.session.operator_session_token, "ops_tok.abc.def");
      assert.equal(result.session.email, "tal@kychee.com");
    }
  });

  it("maps authorization_pending (HTTP 400 + {error}) to a non-throwing result", async () => {
    const { fetch } = mockFetch(() => jsonResponse({ error: "authorization_pending" }, 400));
    const sdk = makeSdk(fetch);
    assert.deepEqual(await sdk.operator.devicePoll("dc"), { kind: "authorization_pending" });
  });

  it("maps slow_down, access_denied, expired_token", async () => {
    for (const code of ["slow_down", "access_denied", "expired_token"] as const) {
      const { fetch } = mockFetch(() => jsonResponse({ error: code }, 400));
      const sdk = makeSdk(fetch);
      assert.deepEqual(await sdk.operator.devicePoll("dc"), { kind: code });
    }
  });

  it("tolerates an error envelope returned with HTTP 200", async () => {
    const { fetch } = mockFetch(() => jsonResponse({ error: "authorization_pending" }, 200));
    const sdk = makeSdk(fetch);
    assert.deepEqual(await sdk.operator.devicePoll("dc"), { kind: "authorization_pending" });
  });

  it("throws on an unexpected response shape (so callers don't loop forever)", async () => {
    const { fetch } = mockFetch(() => jsonResponse({ unexpected: true }, 500));
    const sdk = makeSdk(fetch);
    await assert.rejects(() => sdk.operator.devicePoll("dc"), /Unexpected operator device-token response/);
  });
});

describe("operator.overview", () => {
  it("with a token: sends the bearer and NOT the SIWX header (email-union)", async () => {
    const overview = { scope: { kind: "email", principal: "tal@kychee.com" }, wallets: [{}, {}] };
    const { fetch, calls } = mockFetch(() => jsonResponse(overview));
    const sdk = makeSdk(fetch);
    const result = await sdk.operator.overview({ token: "ops_tok" });

    assert.equal(calls[0]!.url, "https://api.example.test/agent/v1/operator/overview");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer ops_tok");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
    assert.equal(result.scope?.kind, "email");
  });

  it("without a token: falls back to SIWX (wallet slice)", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ scope: { kind: "wallet" } }));
    const sdk = makeSdk(fetch);
    await sdk.operator.overview();

    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.equal(calls[0]!.headers["Authorization"], undefined);
  });
});

describe("operator.revoke", () => {
  it("POSTs the revoke endpoint with the bearer and resolves on 204", async () => {
    const { fetch, calls } = mockFetch(() => new Response(null, { status: 204 }));
    const sdk = makeSdk(fetch);
    await sdk.operator.revoke({ token: "ops_tok" });

    assert.equal(calls[0]!.url, "https://api.example.test/agent/v1/operator/session/revoke");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer ops_tok");
  });
});

describe("operator loopback-PKCE write-login (v1.78)", () => {
  it("buildCliAuthorizeUrl composes the authorize URL with S256 + params (no network)", () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const url = makeSdk(fetch).operator.buildCliAuthorizeUrl({
      redirectUri: "http://127.0.0.1:54321/callback",
      codeChallenge: "chal_abc",
      state: "st_1",
      nonce: "nn_1",
    });
    assert.equal(calls.length, 0, "URL build must not touch the network");
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, "https://api.example.test/agent/v1/control-plane/cli/authorize");
    assert.equal(u.searchParams.get("redirect_uri"), "http://127.0.0.1:54321/callback");
    assert.equal(u.searchParams.get("code_challenge"), "chal_abc");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("state"), "st_1");
    assert.equal(u.searchParams.get("nonce"), "nn_1");
  });

  it("exchangeCliToken POSTs code + verifier to /cli/token, unauthenticated", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, "https://api.example.test/agent/v1/control-plane/cli/token");
      // The code + verifier ARE the credential — no SIWX/bearer header is sent.
      assert.equal(call.headers["SIGN-IN-WITH-X"], undefined);
      assert.equal(call.headers["Authorization"], undefined);
      assert.deepEqual(JSON.parse(String(call.body)), {
        code: "code_1",
        code_verifier: "ver_1",
        redirect_uri: "http://127.0.0.1:54321/callback",
        state: "st_1",
      });
      return jsonResponse({
        control_plane_session_token: "cps_tok",
        token_type: "Bearer",
        expires_in: 900,
        provenance: "loopback_pkce",
        principal_id: "prn_1",
        amr: ["passkey"],
      });
    });
    const session = await makeSdk(fetch).operator.exchangeCliToken({
      code: "code_1",
      codeVerifier: "ver_1",
      redirectUri: "http://127.0.0.1:54321/callback",
      state: "st_1",
    });
    assert.equal(session.control_plane_session_token, "cps_tok");
    assert.equal(session.provenance, "loopback_pkce");
    assert.deepEqual(session.amr, ["passkey"]);
    assert.equal(calls.length, 1);
  });
});

describe("operator.approval ceremony seams (v1.85/v1.87)", () => {
  it("requestChallenge POSTs the challenge with action + target + PKCE, carrying the explicit bearer", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ challenge_id: "ch_1", confirm_url: "https://api.example.test/confirm", delivery: "cli_loopback" }, 201),
    );
    const sdk = makeSdk(fetch);
    const res = await sdk.operator.approval.requestChallenge({
      action: "project.deploy",
      projectId: "prj_x",
      cliRedirectUri: "http://127.0.0.1:5555/callback",
      codeChallenge: "ch4llenge",
      state: "st4te",
      token: "cp_tok",
    });
    assert.equal(calls[0].url, "https://api.example.test/agent/v1/control-plane/write-auth/challenges");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["Authorization"], "Bearer cp_tok");
    assert.equal(calls[0].headers["SIGN-IN-WITH-X"], undefined, "explicit bearer ⇒ no SIWX");
    assert.deepEqual(JSON.parse(String(calls[0].body)), {
      action: "project.deploy",
      cli_redirect_uri: "http://127.0.0.1:5555/callback",
      code_challenge: "ch4llenge",
      state: "st4te",
      project_id: "prj_x",
    });
    assert.equal(res.confirm_url, "https://api.example.test/confirm");
  });

  it("exchangeClaimCode POSTs {code, code_verifier, state} only (no redirect_uri), unauthenticated", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ write_auth_token: "wat_x", token_type: "write_auth", header: "X-Run402-Write-Auth", session: { expires_at: "2099-01-01T00:00:00Z" } }, 201),
    );
    const sdk = makeSdk(fetch);
    const res = await sdk.operator.approval.exchangeClaimCode({ code: "code1", codeVerifier: "ver1", state: "st4te" });
    assert.equal(calls[0].url, "https://api.example.test/agent/v1/control-plane/write-auth/cli/token");
    assert.equal(calls[0].headers["SIGN-IN-WITH-X"], undefined, "unauthenticated exchange");
    const body = JSON.parse(String(calls[0].body));
    assert.deepEqual(body, { code: "code1", code_verifier: "ver1", state: "st4te" });
    assert.equal("redirect_uri" in body, false);
    assert.equal(res.write_auth_token, "wat_x");
  });
});

describe("OperatorApprovalRequiredError mapping", () => {
  it("maps 403 WRITE_AUTH_REQUIRED to a typed error with a resolved approve command", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({ code: "WRITE_AUTH_REQUIRED", error: "needs approval", hint: "..." }, 403),
    );
    const sdk = makeSdk(fetch);
    let threw: unknown;
    try {
      await sdk.projects.provision({ orgId: "org_y" });
    } catch (e) {
      threw = e;
    }
    assert.ok(isOperatorApprovalRequired(threw), "expected OperatorApprovalRequiredError");
    const err = threw as OperatorApprovalRequiredError;
    assert.equal(err.capability, "org.project.create");
    assert.deepEqual(err.target, { org_id: "org_y" });
    assert.equal(err.approveCommand, "run402 operator approve --action org.project.create --org org_y");
    assert.ok(Array.isArray(err.nextActions) && err.nextActions.length > 0);
  });

  it("maps WRITE_AUTH_BINDING_MISMATCH to the same typed error", async () => {
    const { fetch } = mockFetch(() => jsonResponse({ code: "WRITE_AUTH_BINDING_MISMATCH" }, 403));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      () => sdk.projects.provision({ orgId: "org_z" }),
      (e: unknown) => isOperatorApprovalRequired(e),
    );
  });
});
