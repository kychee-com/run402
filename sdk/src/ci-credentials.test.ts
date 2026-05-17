import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  createCiSessionCredentials,
  githubActionsCredentials,
  isCiSessionCredentials,
} from "./ci-credentials.js";
import type { CredentialsProvider } from "./credentials.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("createCiSessionCredentials", () => {
  it("marks the provider as CI credentials and returns Bearer auth", async () => {
    const creds = createCiSessionCredentials({
      projectId: "prj_abc",
      accessToken: "ci-session",
    });

    assert.equal(isCiSessionCredentials(creds), true);
    assert.equal(Object.getOwnPropertySymbols(creds).length, 1);
    assert.deepEqual(await creds.getAuth("/apply/v1/plans"), {
      Authorization: "Bearer ci-session",
    });
    assert.deepEqual(await creds.getProject("prj_abc"), { anon_key: "", service_key: "" });
    assert.equal(await creds.getProject("prj_other"), null);
    assert.equal(await creds.getActiveProject?.(), "prj_abc");
  });

  it("does not treat arbitrary custom Bearer providers as CI", () => {
    const custom: CredentialsProvider = {
      async getAuth() {
        return { Authorization: "Bearer user-session" };
      },
      async getProject() {
        return null;
      },
    };

    assert.equal(isCiSessionCredentials(custom), false);
  });
});

describe("githubActionsCredentials", () => {
  it("requests GitHub OIDC, exchanges through /ci/v1/token-exchange without auth, and caches the session", async () => {
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://actions.example.test/oidc?request=1";
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "github-request-token";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("https://actions.example.test/oidc")) {
        return new Response(JSON.stringify({ value: "github-oidc-jwt" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        access_token: "run402-ci-session",
        token_type: "Bearer",
        expires_in: 120,
        scope: "deploy",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const creds = githubActionsCredentials({
      projectId: "prj_abc",
      apiBase: "https://api.example.test",
      fetch: fetchImpl,
    });

    assert.equal(isCiSessionCredentials(creds), true);
    assert.deepEqual(await creds.getAuth("/apply/v1/plans"), {
      Authorization: "Bearer run402-ci-session",
    });
    assert.deepEqual(await creds.getAuth("/apply/v1/plans/plan_abc/commit"), {
      Authorization: "Bearer run402-ci-session",
    });
    assert.equal(calls.length, 2, "second auth call should use cached session");
    assert.equal(
      calls[0]!.url,
      "https://actions.example.test/oidc?request=1&audience=https%3A%2F%2Fapi.run402.com",
    );
    assert.equal(
      (calls[0]!.init?.headers as Record<string, string>).Authorization,
      "Bearer github-request-token",
    );
    assert.equal(calls[1]!.url, "https://api.example.test/ci/v1/token-exchange");
    assert.equal((calls[1]!.init?.headers as Record<string, string>).Authorization, undefined);
    assert.deepEqual(JSON.parse(calls[1]!.init?.body as string), {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "github-oidc-jwt",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      project_id: "prj_abc",
    });
  });

  it("refreshes according to expires_in instead of assuming 900 seconds", async () => {
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://actions.example.test/oidc";
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "github-request-token";
    let exchangeCount = 0;
    const fetchImpl: typeof globalThis.fetch = async (url) => {
      if (String(url).startsWith("https://actions.example.test/oidc")) {
        return new Response(JSON.stringify({ value: `github-oidc-${exchangeCount}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      exchangeCount += 1;
      return new Response(JSON.stringify({
        access_token: `run402-ci-session-${exchangeCount}`,
        token_type: "Bearer",
        expires_in: 1,
        scope: "deploy",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const creds = githubActionsCredentials({
      projectId: "prj_abc",
      apiBase: "https://api.example.test",
      refreshBeforeSeconds: 2,
      fetch: fetchImpl,
    });

    assert.deepEqual(await creds.getAuth("/apply/v1/plans"), {
      Authorization: "Bearer run402-ci-session-1",
    });
    assert.deepEqual(await creds.getAuth("/apply/v1/plans"), {
      Authorization: "Bearer run402-ci-session-2",
    });
  });
});
