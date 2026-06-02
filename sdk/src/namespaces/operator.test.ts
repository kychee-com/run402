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
