import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  Run402,
  assertCiDeployableSpec,
  buildCiDelegationResourceUri,
  buildCiDelegationStatement,
  normalizeCiDelegationValues,
  validateCiNonce,
  validateCiSubjectMatch,
  CI_AUDIENCE,
  CI_GITHUB_ACTIONS_ISSUER,
  CI_GITHUB_ACTIONS_PROVIDER,
  DEFAULT_CI_DELEGATION_CHAIN_ID,
  V1_CI_ALLOWED_EVENTS_DEFAULT,
} from "../index.js";
import { ApiError, LocalError, Run402DeployError, Unauthorized } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";
import type { CiBindingRow } from "./ci.types.js";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeCreds(
  overrides: Partial<CredentialsProvider> = {},
): CredentialsProvider {
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

const CANONICAL = {
  project_id: "prj_abc",
  issuer: CI_GITHUB_ACTIONS_ISSUER,
  audience: CI_AUDIENCE,
  subject_match: "repo:tal/myapp:ref:refs/heads/main",
  allowed_actions: ["deploy"],
  allowed_events: ["push", "workflow_dispatch"],
  expires_at: "2026-07-30T00:00:00Z",
  github_repository_id: "892341",
  nonce: "deadbeef00112233aabbccdd44556677",
} as const;

const STATEMENT_GOLDEN = `Authorize GitHub Actions workflows whose OIDC subject matches repo:tal/myapp:ref:refs/heads/main to deploy to run402 project prj_abc.

The workflows can:
  - deploy function code that runs with this project's runtime authority, including the project's service-role key, the adminDb() bypass-RLS surface, and configured runtime secrets read via process.env;
  - deploy database migrations, RLS/expose changes, and schema-altering SQL via spec.database.

The workflows cannot directly call secrets, domain, subdomain, lifecycle, billing, contracts, or faucet endpoints. They cannot ship spec.secrets, spec.subdomains, spec.routes, spec.checks, or non-current spec.base.

Audience: https://api.run402.com
Allowed events: push,workflow_dispatch
Repository ID: 892341
Expires: 2026-07-30T00:00:00Z
Nonce: deadbeef00112233aabbccdd44556677

Revoke at any time via the run402 CLI or POST /ci/v1/bindings/:id/revoke. Revocation stops future CI gateway requests but does not undo already-deployed code, stop in-flight deploy operations, rotate exfiltrated keys, or remove deployed functions. Recovery from a compromise: revoke the binding, then SIWE-deploy a known-good release that overwrites the malicious code, and rotate any service-role key the deployed code may have read.`;

const RESOURCE_URI_GOLDEN =
  "run402-ci-delegation:v1?project_id=prj_abc&issuer=https%3A%2F%2Ftoken.actions.githubusercontent.com&audience=https%3A%2F%2Fapi.run402.com&subject_match=repo%3Atal%2Fmyapp%3Aref%3Arefs%2Fheads%2Fmain&allowed_actions=deploy&allowed_events=push,workflow_dispatch&expires_at=2026-07-30T00%3A00%3A00Z&github_repository_id=892341&nonce=deadbeef00112233aabbccdd44556677";

function row(overrides: Partial<CiBindingRow> = {}): CiBindingRow {
  return {
    id: "bnd_abc",
    project_id: "prj_abc",
    issuer: CI_GITHUB_ACTIONS_ISSUER,
    subject_match: CANONICAL.subject_match,
    allowed_actions: ["deploy"],
    allowed_events: ["push", "workflow_dispatch"],
    github_repository_id: "892341",
    created_by: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    nonce: CANONICAL.nonce,
    created_at: "2026-05-03T00:00:00Z",
    expires_at: "2026-07-30T00:00:00Z",
    revoked_at: null,
    last_used_at: null,
    use_count: 0,
    ...overrides,
  };
}

describe("ci namespace wire methods", () => {
  it("creates a binding with SIWX auth and normalized canonical arrays", async () => {
    const expected = row();
    const { fetch, calls } = mockFetch(() => jsonResponse(expected, 201));
    const sdk = makeSdk(makeCreds(), fetch);

    const result = await sdk.ci.createBinding({
      project_id: "prj_abc",
      provider: CI_GITHUB_ACTIONS_PROVIDER,
      subject_match: CANONICAL.subject_match,
      allowed_actions: ["deploy"],
      allowed_events: ["workflow_dispatch", "push", "push"],
      github_repository_id: "892341",
      expires_at: "2026-07-30T00:00:00Z",
      nonce: CANONICAL.nonce,
      signed_delegation: "signed",
    });

    assert.deepEqual(result, expected);
    assert.equal(calls[0]!.url, "https://api.example.test/ci/v1/bindings");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      project_id: "prj_abc",
      provider: "github-actions",
      subject_match: CANONICAL.subject_match,
      allowed_actions: ["deploy"],
      allowed_events: ["push", "workflow_dispatch"],
      github_repository_id: "892341",
      expires_at: "2026-07-30T00:00:00Z",
      nonce: CANONICAL.nonce,
      signed_delegation: "signed",
    });
  });

  it("lists, gets, and revokes bindings", async () => {
    const detail = row({
      created_sig: {
        payload: { statement: "ok" },
        raw: "signed",
        signer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        verified_at: "2026-05-03T00:00:00Z",
      },
    });
    const { fetch, calls } = mockFetch((call) => {
      if (call.url.endsWith("/ci/v1/bindings?project=prj_abc")) {
        return jsonResponse({ bindings: [row()] });
      }
      if (call.url.endsWith("/ci/v1/bindings/bnd_abc") && call.method === "GET") {
        return jsonResponse(detail);
      }
      if (call.url.endsWith("/ci/v1/bindings/bnd_abc/revoke")) {
        return jsonResponse(row({ revoked_at: "2026-05-03T01:00:00Z" }));
      }
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });
    const sdk = makeSdk(makeCreds(), fetch);

    assert.equal((await sdk.ci.listBindings({ project: "prj_abc" })).bindings.length, 1);
    assert.deepEqual(await sdk.ci.getBinding("bnd_abc"), detail);
    assert.equal((await sdk.ci.revokeBinding("bnd_abc")).revoked_at, "2026-05-03T01:00:00Z");

    assert.deepEqual(
      calls.map((call) => [call.method, call.url.replace("https://api.example.test", "")]),
      [
        ["GET", "/ci/v1/bindings?project=prj_abc"],
        ["GET", "/ci/v1/bindings/bnd_abc"],
        ["POST", "/ci/v1/bindings/bnd_abc/revoke"],
      ],
    );
    assert.ok(calls.every((call) => call.headers["SIGN-IN-WITH-X"] === "test-siwx"));
  });

  it("exchanges an OIDC token without credential-provider auth headers", async () => {
    let authCalls = 0;
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        access_token: "ci-session",
        token_type: "Bearer",
        expires_in: 123,
        scope: "deploy",
      }),
    );
    const sdk = makeSdk(
      makeCreds({
        async getAuth() {
          authCalls += 1;
          return { "SIGN-IN-WITH-X": "must-not-send" };
        },
      }),
      fetch,
    );

    const result = await sdk.ci.exchangeToken({
      project_id: "prj_abc",
      subject_token: "github-oidc-jwt",
    });

    assert.equal(authCalls, 0);
    assert.deepEqual(result, {
      access_token: "ci-session",
      token_type: "Bearer",
      expires_in: 123,
      scope: "deploy",
    });
    assert.equal(calls[0]!.url, "https://api.example.test/ci/v1/token-exchange");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "github-oidc-jwt",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      project_id: "prj_abc",
    });
  });

  it("preserves gateway CI error bodies", async () => {
    const cases = [
      { code: "nonce_replay", status: 400, method: "create" },
      { code: "invalid_token", status: 401, method: "exchange" },
      { code: "event_not_allowed", status: 403, method: "exchange" },
      { code: "repository_id_mismatch", status: 403, method: "exchange" },
      { code: "forbidden_spec_field", status: 403, method: "create" },
      { code: "forbidden_plan", status: 403, method: "create" },
    ] as const;

    for (const c of cases) {
      const body = { code: c.code, message: `gateway ${c.code}` };
      const { fetch } = mockFetch(() => jsonResponse(body, c.status));
      const sdk = makeSdk(makeCreds(), fetch);
      const promise = c.method === "exchange"
        ? sdk.ci.exchangeToken({ project_id: "prj_abc", subject_token: "jwt" })
        : sdk.ci.createBinding({
          project_id: "prj_abc",
          provider: CI_GITHUB_ACTIONS_PROVIDER,
          subject_match: CANONICAL.subject_match,
          allowed_actions: ["deploy"],
          allowed_events: ["push", "workflow_dispatch"],
          nonce: CANONICAL.nonce,
          signed_delegation: "signed",
        });
      await assert.rejects(
        promise,
        (err: unknown) => {
          assert.ok(err instanceof ApiError || err instanceof Unauthorized);
          assert.deepEqual((err as ApiError | Unauthorized).body, body);
          assert.equal((err as ApiError | Unauthorized).code, c.code);
          return true;
        },
      );
    }
  });
});

describe("CI canonical delegation builders", () => {
  it("matches the gateway Statement and Resource URI golden vectors", () => {
    assert.equal(buildCiDelegationStatement(CANONICAL), STATEMENT_GOLDEN);
    assert.equal(buildCiDelegationResourceUri(CANONICAL), RESOURCE_URI_GOLDEN);
  });

  it("uses Base Sepolia as the default delegation chain for current SDK/CLI tests", () => {
    assert.equal(DEFAULT_CI_DELEGATION_CHAIN_ID, "eip155:84532");
  });

  it("renders nullable values as never/none-soft-bound and omits nullable URI params", () => {
    const values = {
      ...CANONICAL,
      expires_at: null,
      github_repository_id: null,
    };
    const statement = buildCiDelegationStatement(values);
    assert.match(statement, /^Expires: never$/m);
    assert.match(statement, /^Repository ID: none-soft-bound$/m);
    const uri = buildCiDelegationResourceUri(values);
    assert.ok(!uri.includes("expires_at="));
    assert.ok(!uri.includes("github_repository_id="));
    assert.ok(uri.endsWith(`&nonce=${CANONICAL.nonce}`));
  });

  it("sorts and dedupes arrays before rendering", () => {
    const values = {
      ...CANONICAL,
      allowed_actions: ["deploy", "deploy"],
      allowed_events: ["workflow_dispatch", "push", "push"],
    };
    const normalized = normalizeCiDelegationValues(values);
    assert.deepEqual(normalized.allowed_actions, ["deploy"]);
    assert.deepEqual(normalized.allowed_events, ["push", "workflow_dispatch"]);
    assert.match(
      buildCiDelegationStatement(values),
      /^Allowed events: push,workflow_dispatch$/m,
    );
    assert.ok(
      buildCiDelegationResourceUri(values).includes("allowed_events=push,workflow_dispatch"),
    );
  });

  it("encodes literal punctuation in subjects without treating it as a pattern", () => {
    const values = {
      ...CANONICAL,
      subject_match: "repo:tal/my.app+one:ref:refs/heads/feat[1]?",
    };
    assert.equal(validateCiSubjectMatch(values.subject_match), values.subject_match);
    assert.ok(
      buildCiDelegationResourceUri(values).includes(
        "subject_match=repo%3Atal%2Fmy.app%2Bone%3Aref%3Arefs%2Fheads%2Ffeat%5B1%5D%3F",
      ),
    );
  });
});

describe("CI validation helpers", () => {
  it("rejects invalid subject patterns", () => {
    const invalid = ["", "*", "repo:*:bad", "repo:a*b*", `repo:${"x".repeat(260)}`, "repo:\nnope"];
    for (const subject of invalid) {
      assert.throws(() => validateCiSubjectMatch(subject), LocalError, subject);
    }
  });

  it("rejects invalid nonce values", () => {
    const invalid = ["", "DEADBEEF00112233", "abc", "g".repeat(16), "a".repeat(65)];
    for (const nonce of invalid) {
      assert.throws(() => validateCiNonce(nonce), LocalError, nonce);
    }
  });

  it("rejects v1 actions other than deploy", () => {
    assert.throws(
      () => normalizeCiDelegationValues({ ...CANONICAL, allowed_actions: ["deploy", "delete"] }),
      /allowed_actions/,
    );
    assert.throws(
      () => normalizeCiDelegationValues({ ...CANONICAL, allowed_actions: [] }),
      /allowed_actions/,
    );
  });

  it("keeps the default allowed events constant stable", () => {
    assert.deepEqual([...V1_CI_ALLOWED_EVENTS_DEFAULT], ["push", "workflow_dispatch"]);
  });
});

describe("assertCiDeployableSpec", () => {
  it("accepts project, database, functions, site, and current base", () => {
    assert.doesNotThrow(() =>
      assertCiDeployableSpec({
        project: "prj_abc",
        base: { release: "current" },
        database: { migrations: [] },
        functions: { patch: { delete: ["old"] } },
        site: { patch: { delete: ["old.html"] } },
      }),
    );
    assert.doesNotThrow(() =>
      assertCiDeployableSpec({
        spec: { project: "prj_abc", site: { patch: { delete: ["old.html"] } } },
        manifest_ref: null,
      }),
    );
  });

  it("rejects forbidden fields by property presence, including empty containers", () => {
    for (const field of ["secrets", "subdomains", "routes", "checks"]) {
      assert.throws(
        () => assertCiDeployableSpec({ project: "prj_abc", [field]: field === "checks" ? [] : {} }),
        (err: unknown) =>
          err instanceof Run402DeployError &&
          err.code === "forbidden_spec_field" &&
          err.resource === field,
      );
    }
  });

  it("rejects unknown future fields, non-current base, and non-null manifest_ref", () => {
    assert.throws(
      () => assertCiDeployableSpec({ project: "prj_abc", lifecycle: {} }),
      (err: unknown) => err instanceof Run402DeployError && err.resource === "lifecycle",
    );
    assert.throws(
      () => assertCiDeployableSpec({ project: "prj_abc", base: { release: "empty" } }),
      (err: unknown) => err instanceof Run402DeployError && err.resource === "base",
    );
    assert.throws(
      () =>
        assertCiDeployableSpec({
          spec: { project: "prj_abc" },
          manifest_ref: { sha256: "a".repeat(64), size: 1 },
        }),
      (err: unknown) => err instanceof Run402DeployError && err.resource === "manifest_ref",
    );
  });
});
