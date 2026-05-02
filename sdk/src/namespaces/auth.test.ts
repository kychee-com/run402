/**
 * Unit tests for the `auth` namespace. Each test mocks `fetch` via a custom
 * implementation passed to `new Run402()`. Verifies URL, method, headers,
 * body composition, and entry-guard behavior on undefined/null/non-object
 * args (the realistic shape when a CLI flag parser passes through `any`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { LocalError, ProjectNotFound } from "../errors.js";
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
        return { anon_key: "anon_xxx", service_key: "service_xxx" };
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

describe("auth.settings", () => {
  it("PATCHes /auth/v1/settings with the body and service-key bearer", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ ok: true }));
    const sdk = makeSdk(makeCreds(), fetch);
    await sdk.auth.settings("prj_known", { allow_password_set: true });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/auth/v1/settings");
    assert.equal(calls[0]!.method, "PATCH");
    assert.equal(calls[0]!.headers["apikey"], "anon_xxx");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer service_xxx");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      allow_password_set: true,
    });
  });

  it("throws LocalError when settings arg is undefined (cast through any)", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sdk.auth.settings as any)("prj_known"),
      (err: unknown) =>
        err instanceof LocalError &&
        err.kind === "local_error" &&
        /settings/.test(err.message),
    );
    assert.equal(calls.length, 0);
  });

  it("throws LocalError when settings arg is null", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdk.auth.settings("prj_known", null as any),
      (err: unknown) =>
        err instanceof LocalError &&
        err.kind === "local_error" &&
        /settings/.test(err.message),
    );
    assert.equal(calls.length, 0);
  });

  it("throws LocalError when settings arg is not an object (string)", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdk.auth.settings("prj_known", "not an object" as any),
      (err: unknown) =>
        err instanceof LocalError &&
        err.kind === "local_error" &&
        /settings/.test(err.message),
    );
    assert.equal(calls.length, 0);
  });

  it("throws ProjectNotFound for unknown ids before hitting the network", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(
      sdk.auth.settings("prj_missing", { allow_password_set: true }),
      ProjectNotFound,
    );
    assert.equal(calls.length, 0);
  });
});

describe("auth.providers", () => {
  it("lists configured auth providers with the project anon key (GH-181)", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ providers: ["email", "google"] }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.auth.providers("prj_known");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/auth/v1/providers");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers["apikey"], "anon_xxx");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer anon_xxx");
    assert.deepEqual(result, { providers: ["email", "google"] });
  });

  it("throws ProjectNotFound for unknown ids before hitting the network", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(sdk.auth.providers("prj_missing"), ProjectNotFound);
    assert.equal(calls.length, 0);
  });
});

describe("auth.requestMagicLink", () => {
  it("POSTs /auth/v1/magic-link with anon-key apikey + bearer", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ ok: true }));
    const sdk = makeSdk(makeCreds(), fetch);
    await sdk.auth.requestMagicLink("prj_known", {
      email: "user@example.com",
      redirectUrl: "https://app.example.com/callback",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/auth/v1/magic-link");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["apikey"], "anon_xxx");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer anon_xxx");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      email: "user@example.com",
      redirect_url: "https://app.example.com/callback",
    });
  });

  it("throws LocalError when opts is undefined (cast through any)", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sdk.auth.requestMagicLink as any)("prj_known"),
      (err: unknown) =>
        err instanceof LocalError &&
        err.kind === "local_error" &&
        /opts|email/.test(err.message),
    );
    assert.equal(calls.length, 0);
  });

  it("throws LocalError when opts is null", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdk.auth.requestMagicLink("prj_known", null as any),
      (err: unknown) =>
        err instanceof LocalError &&
        err.kind === "local_error" &&
        /opts|email/.test(err.message),
    );
    assert.equal(calls.length, 0);
  });
});

describe("auth.setUserPassword", () => {
  it("PUTs /auth/v1/user/password with newPassword and accessToken bearer", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ ok: true }));
    const sdk = makeSdk(makeCreds(), fetch);
    await sdk.auth.setUserPassword("prj_known", {
      accessToken: "user_jwt",
      newPassword: "hunter2-correct",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/auth/v1/user/password");
    assert.equal(calls[0]!.method, "PUT");
    assert.equal(calls[0]!.headers["apikey"], "anon_xxx");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer user_jwt");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      new_password: "hunter2-correct",
    });
  });

  it("includes current_password when provided (password-change flow)", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ ok: true }));
    const sdk = makeSdk(makeCreds(), fetch);
    await sdk.auth.setUserPassword("prj_known", {
      accessToken: "user_jwt",
      newPassword: "new-password",
      currentPassword: "old-password",
    });

    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      new_password: "new-password",
      current_password: "old-password",
    });
  });

  it("throws LocalError when opts is undefined (cast through any)", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sdk.auth.setUserPassword as any)("prj_known"),
      (err: unknown) =>
        err instanceof LocalError &&
        err.kind === "local_error" &&
        /opts|password/.test(err.message),
    );
    assert.equal(calls.length, 0);
  });

  it("throws LocalError when opts is null", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdk.auth.setUserPassword("prj_known", null as any),
      (err: unknown) =>
        err instanceof LocalError &&
        err.kind === "local_error" &&
        /opts|password/.test(err.message),
    );
    assert.equal(calls.length, 0);
  });
});
