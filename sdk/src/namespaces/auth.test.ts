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
import type {
  CreateAuthUserOptions,
  MagicLinkOptions,
  SetPasswordOptions,
} from "./auth.js";

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

  it("rejects unknown settings keys before requesting", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new Error("unexpected fetch for unknown auth setting");
    });
    const sdk = makeSdk(makeCreds(), fetch);

    await assert.rejects(
      sdk.auth.settings("prj_known", { allow_passwrod_login: true } as any),
      (err: unknown) =>
        err instanceof LocalError &&
        err.context === "updating auth settings" &&
        /Unknown auth settings field: allow_passwrod_login/.test(err.message),
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

  it("rejects malformed email, redirect URL, and intent before requesting", async () => {
    const invalid: MagicLinkOptions[] = [
      { email: "not an email", redirectUrl: "https://app.example.com/callback" },
      { email: "user@example.com", redirectUrl: "javascript:alert(1)" },
      { email: "user@example.com", redirectUrl: "https://app.example.com/callback", intent: "bogus" as any },
    ];

    for (const opts of invalid) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error("unexpected fetch for invalid magic-link options");
      });
      const sdk = makeSdk(makeCreds(), fetch);
      await assert.rejects(
        sdk.auth.requestMagicLink("prj_known", opts),
        (err: unknown) =>
          err instanceof LocalError &&
          err.context === "requesting magic link",
      );
      assert.equal(calls.length, 0);
    }
  });
});

describe("auth.createUser", () => {
  it("POSTs /auth/v1/admin/users with service-key bearer", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({
      id: "u1",
      email: "admin@example.com",
      is_admin: true,
      email_verified_at: null,
      created: true,
      invite_sent: true,
    }));
    const sdk = makeSdk(makeCreds(), fetch);
    await sdk.auth.createUser("prj_known", {
      email: "admin@example.com",
      isAdmin: true,
      sendInvite: true,
      redirectUrl: "https://app.example.com/cb",
      clientState: "state-1",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/auth/v1/admin/users");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["apikey"], "anon_xxx");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer service_xxx");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      email: "admin@example.com",
      is_admin: true,
      send_invite: true,
      redirect_url: "https://app.example.com/cb",
      client_state: "state-1",
    });
  });

  it("rejects malformed email and redirect URL before requesting", async () => {
    const invalid: CreateAuthUserOptions[] = [
      { email: "not an email" },
      { email: "admin@example.com", redirectUrl: "javascript:alert(1)" },
    ];

    for (const opts of invalid) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error("unexpected fetch for invalid admin user options");
      });
      const sdk = makeSdk(makeCreds(), fetch);
      await assert.rejects(
        sdk.auth.createUser("prj_known", opts),
        (err: unknown) =>
          err instanceof LocalError &&
          err.context === "creating auth user",
      );
      assert.equal(calls.length, 0);
    }
  });

  it("inviteUser reuses createUser validation", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new Error("unexpected fetch for invalid invite user options");
    });
    const sdk = makeSdk(makeCreds(), fetch);

    await assert.rejects(
      sdk.auth.inviteUser("prj_known", {
        email: "bad",
        redirectUrl: "javascript:alert(1)",
      }),
      LocalError,
    );
    assert.equal(calls.length, 0);
  });
});

describe("auth.passkeys", () => {
  it("creates registration options with user bearer", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ challenge_id: "challenge-1", options: { challenge: "abc" } }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    await sdk.auth.createPasskeyRegistrationOptions("prj_known", {
      accessToken: "user_jwt",
      appOrigin: "https://app.example.com",
    });

    assert.equal(calls[0]!.url, "https://api.example.test/auth/v1/passkeys/register/options");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["apikey"], "anon_xxx");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer user_jwt");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      app_origin: "https://app.example.com",
    });
  });

  it("verifies passkey login with anon bearer", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        access_token: "access",
        refresh_token: "refresh",
        token_type: "bearer",
        expires_in: 3600,
        user: { id: "u1", email: "u@example.com" },
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    await sdk.auth.verifyPasskeyLogin("prj_known", {
      challengeId: "challenge-1",
      response: { id: "credential-1" },
    });

    assert.equal(calls[0]!.url, "https://api.example.test/auth/v1/passkeys/login/verify");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["apikey"], "anon_xxx");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer anon_xxx");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      challenge_id: "challenge-1",
      response: { id: "credential-1" },
    });
  });

  it("lists and deletes passkeys with user bearer", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ passkeys: [] }));
    const sdk = makeSdk(makeCreds(), fetch);
    await sdk.auth.listPasskeys("prj_known", { accessToken: "user_jwt" });
    await sdk.auth.deletePasskey("prj_known", {
      accessToken: "user_jwt",
      passkeyId: "00000000-0000-4000-8000-000000000001",
    });

    assert.equal(calls[0]!.url, "https://api.example.test/auth/v1/passkeys");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer user_jwt");
    assert.equal(
      calls[1]!.url,
      "https://api.example.test/auth/v1/passkeys/00000000-0000-4000-8000-000000000001",
    );
    assert.equal(calls[1]!.method, "DELETE");
    assert.equal(calls[1]!.headers["Authorization"], "Bearer user_jwt");
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

  it("rejects empty access token, new password, and current password before requesting", async () => {
    const invalid: SetPasswordOptions[] = [
      { accessToken: "", newPassword: "new-password" },
      { accessToken: "user_jwt", newPassword: "" },
      { accessToken: "user_jwt", newPassword: "new-password", currentPassword: "" },
    ];

    for (const opts of invalid) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error("unexpected fetch for invalid password options");
      });
      const sdk = makeSdk(makeCreds(), fetch);
      await assert.rejects(
        sdk.auth.setUserPassword("prj_known", opts),
        (err: unknown) =>
          err instanceof LocalError &&
          err.context === "setting user password",
      );
      assert.equal(calls.length, 0);
    }
  });
});

describe("auth.verifyMagicLink", () => {
  it("rejects empty or non-string tokens before requesting", async () => {
    const invalid = ["", null, 42];

    for (const token of invalid) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error("unexpected fetch for invalid magic-link token");
      });
      const sdk = makeSdk(makeCreds(), fetch);
      await assert.rejects(
        sdk.auth.verifyMagicLink("prj_known", token as any),
        (err: unknown) =>
          err instanceof LocalError &&
          err.context === "verifying magic link",
      );
      assert.equal(calls.length, 0);
    }
  });
});
