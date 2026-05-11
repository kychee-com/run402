/**
 * Unit tests for the project-scoped sub-client (`r.project(id?)` / `r.useProject(id)`).
 *
 * Covers:
 *   - resolution: explicit id, no-arg + active, no-arg + missing getActiveProject, no-arg + null
 *   - useProject sugar: persists then returns scope, propagates errors
 *   - wrapper routing: first-arg injection, options-object injection, caller override, pass-through
 *   - drift protection: every project-id-bearing namespace method on Run402 has a wrapper
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "./index.js";
import { ScopedRun402 } from "./scoped.js";
import { ProjectNotFound, LocalError } from "./errors.js";
import type { CredentialsProvider } from "./credentials.js";

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

describe("r.project() resolution", () => {
  it("explicit id binds without consulting getActiveProject", async () => {
    let activeCalls = 0;
    let projectLookupCalls = 0;
    const creds = makeCreds({
      async getActiveProject() {
        activeCalls += 1;
        return "prj_other";
      },
      async getProject(id: string) {
        projectLookupCalls += 1;
        if (id === "prj_known") return { anon_key: "a", service_key: "s" };
        return null;
      },
    });
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(creds, fetch);
    const p = await sdk.project("prj_explicit");
    assert.ok(p instanceof ScopedRun402);
    assert.equal(p.projectId, "prj_explicit");
    assert.equal(activeCalls, 0, "getActiveProject must NOT be called when id is explicit");
    assert.equal(projectLookupCalls, 0, "getProject must NOT be called at construction");
  });

  it("no-arg call resolves from credentials.getActiveProject()", async () => {
    const creds = makeCreds({
      async getActiveProject() {
        return "prj_active";
      },
    });
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(creds, fetch);
    const p = await sdk.project();
    assert.equal(p.projectId, "prj_active");
  });

  it("no-arg throws LocalError when provider lacks getActiveProject", async () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(
      sdk.project(),
      (err: unknown) =>
        err instanceof LocalError &&
        err.context === "scoping client to project" &&
        /requires a credential provider that implements getActiveProject/.test(err.message),
    );
  });

  it("no-arg throws LocalError when getActiveProject returns null", async () => {
    const creds = makeCreds({
      async getActiveProject() {
        return null;
      },
    });
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(creds, fetch);
    await assert.rejects(
      sdk.project(),
      (err: unknown) =>
        err instanceof LocalError &&
        err.context === "scoping client to project" &&
        /No active project set/.test(err.message),
    );
  });
});

describe("r.useProject() sugar", () => {
  it("calls setActiveProject and returns scoped client", async () => {
    const order: string[] = [];
    const creds = makeCreds({
      async setActiveProject(id) {
        order.push(`set:${id}`);
      },
    });
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(creds, fetch);
    const p = await sdk.useProject("prj_known");
    order.push(`return:${p.projectId}`);
    assert.deepEqual(order, ["set:prj_known", "return:prj_known"]);
    assert.ok(p instanceof ScopedRun402);
  });

  it("propagates ProjectNotFound when id is unknown", async () => {
    const setCalls: string[] = [];
    const creds = makeCreds({
      async setActiveProject(id) {
        setCalls.push(id);
      },
    });
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(creds, fetch);
    await assert.rejects(
      sdk.useProject("prj_unknown"),
      (err: unknown) => err instanceof ProjectNotFound && err.projectId === "prj_unknown",
    );
    assert.deepEqual(setCalls, [], "setActiveProject must NOT be called when id lookup fails");
  });

  it("propagates 'provider does not support setActiveProject'", async () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(
      sdk.useProject("prj_known"),
      (err: unknown) =>
        err instanceof Error && /does not support setActiveProject/.test((err as Error).message),
    );
  });
});

describe("ScopedRun402 wrapper routing", () => {
  it("injects projectId for first-arg methods (projects.getUsage)", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        project_id: "prj_known",
        api_calls: 0,
        storage_bytes: 0,
        tier: "prototype",
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const p = await sdk.project("prj_known");
    await p.projects.getUsage();
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/projects\/v1\/admin\/prj_known\/usage$/);
    assert.equal(calls[0]!.headers.Authorization, "Bearer service_xxx");
  });

  it("scoped projects.validateExpose injects project context", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ hasErrors: false, errors: [], warnings: [] }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const p = await sdk.project("prj_known");

    await p.projects.validateExpose({ version: "1", tables: [] });

    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/projects\/v1\/admin\/prj_known\/expose\/validate$/);
    assert.equal(calls[0]!.headers.Authorization, "Bearer service_xxx");
  });

  it("injects project for options-object methods (deploy.list)", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ operations: [] }));
    const sdk = makeSdk(makeCreds(), fetch);
    const p = await sdk.project("prj_known");
    await p.deploy.list();
    assert.equal(calls.length, 1);
    // deploy.list calls `apikeyHeaders(client, opts.project)` which loads `prj_known`
    // from creds and sends its anon_key as the "apikey" header.
    assert.equal(calls[0]!.headers.apikey, "anon_xxx");
  });

  it("caller-supplied project overrides the scoped id", async () => {
    const ledger: string[] = [];
    const creds = makeCreds({
      async getProject(id: string) {
        ledger.push(`lookup:${id}`);
        if (id === "prj_known") return { anon_key: "anon_known", service_key: "service_known" };
        if (id === "prj_other") return { anon_key: "anon_other", service_key: "service_other" };
        return null;
      },
    });
    const { fetch, calls } = mockFetch(() => jsonResponse({ operations: [] }));
    const sdk = makeSdk(creds, fetch);
    const p = await sdk.project("prj_known");
    await p.deploy.list({ project: "prj_other" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.headers.apikey, "anon_other");
    assert.deepEqual(ledger, ["lookup:prj_other"]);
  });

  it("scoped release observability wrappers bind project and preserve overrides", async () => {
    const ledger: string[] = [];
    const creds = makeCreds({
      async getProject(id: string) {
        ledger.push(`lookup:${id}`);
        if (id === "prj_known") return { anon_key: "anon_known", service_key: "service_known" };
        if (id === "prj_other") return { anon_key: "anon_other", service_key: "service_other" };
        return null;
      },
    });
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        kind: "release_inventory",
        schema_version: "agent-deploy-observability.v1",
        release_id: "rel_1",
        project_id: "prj_known",
        parent_id: null,
        status: "active",
        manifest_digest: null,
        created_at: null,
        created_by: null,
        activated_at: null,
        superseded_at: null,
        operation_id: null,
        plan_id: null,
        events_url: null,
        effective: true,
        state_kind: "effective",
        site: { paths: [] },
        functions: [],
        secrets: { keys: [] },
        subdomains: { names: [] },
        migrations_applied: [],
      }),
    );
    const sdk = makeSdk(creds, fetch);
    const p = await sdk.project("prj_known");

    await p.deploy.getRelease("rel_1");
    await p.deploy.getActiveRelease({ project: "prj_other", siteLimit: 3 });

    assert.match(calls[0]!.url, /\/deploy\/v2\/releases\/rel_1$/);
    assert.equal(calls[0]!.headers.apikey, "anon_known");
    assert.match(calls[1]!.url, /\/deploy\/v2\/releases\/active\?site_limit=3$/);
    assert.equal(calls[1]!.headers.apikey, "anon_other");
    assert.deepEqual(ledger, ["lookup:prj_known", "lookup:prj_other"]);
  });

  it("scoped release diff binds the project id", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        kind: "release_diff",
        schema_version: "agent-deploy-observability.v1",
        from_release_id: null,
        to_release_id: "rel_1",
        is_noop: true,
        summary: "No changes",
        warnings: [],
        migrations: { applied_between_releases: [] },
        site: { added: [], removed: [], changed: [] },
        functions: { added: [], removed: [], changed: [] },
        secrets: { added: [], removed: [] },
        subdomains: { added: [], removed: [] },
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const p = await sdk.project("prj_known");

    await p.deploy.diff({ from: "empty", to: "active", limit: 10 });

    assert.match(calls[0]!.url, /\/deploy\/v2\/releases\/diff\?from=empty&to=active&limit=10$/);
    assert.equal(calls[0]!.headers.apikey, "anon_xxx");
  });

  it("scoped deploy.resolve binds project and preserves explicit overrides", async () => {
    const ledger: string[] = [];
    const creds = makeCreds({
      async getProject(id: string) {
        ledger.push(`lookup:${id}`);
        if (id === "prj_known") return { anon_key: "anon_known", service_key: "service_known" };
        if (id === "prj_other") return { anon_key: "anon_other", service_key: "service_other" };
        return null;
      },
    });
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        hostname: "example.com",
        result: 200,
        match: "static_exact",
        authorized: true,
        fallback_state: "not_used",
      }),
    );
    const sdk = makeSdk(creds, fetch);
    const p = await sdk.project("prj_known");

    await p.deploy.resolve({ url: "https://example.com/" });
    await p.deploy.resolve({ project: "prj_other", host: "other.example", path: "/x" });

    assert.match(calls[0]!.url, /\/deploy\/v2\/resolve\?host=example\.com&path=%2F$/);
    assert.equal(calls[0]!.headers.apikey, "anon_known");
    assert.match(calls[1]!.url, /\/deploy\/v2\/resolve\?host=other\.example&path=%2Fx$/);
    assert.equal(calls[1]!.headers.apikey, "anon_other");
    assert.deepEqual(ledger, ["lookup:prj_known", "lookup:prj_other"]);
  });

  it("non-id-bearing methods pass through unchanged (projects.list)", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ projects: [] }));
    const sdk = makeSdk(makeCreds(), fetch);
    const p = await sdk.project("prj_known");
    await p.projects.list("0xWALLETADDRESS");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/wallets\/v1\/0xwalletaddress\/projects$/);
  });

  it("ProjectNotFound surfaces unchanged from the scoped client", async () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    const p = await sdk.project("prj_ghost");
    await assert.rejects(
      p.projects.getUsage(),
      (err: unknown) => err instanceof ProjectNotFound && err.projectId === "prj_ghost",
    );
  });

  it("scoped deploy.apply injects spec.project", async () => {
    const { fetch, calls } = mockFetch((call) => {
      if (call.url.endsWith("/deploy/v2/plans") && call.method === "POST") {
        return jsonResponse({
          plan_id: "pl_x",
          manifest_digest: "sha256:zero",
          missing_content: [],
          diff: {},
        });
      }
      // commit
      if (call.url.endsWith("/commit") && call.method === "POST") {
        return jsonResponse({ operation_id: "op_x" });
      }
      // poll
      return jsonResponse({
        operation_id: "op_x",
        status: "ready",
        release_id: "rel_x",
        phase: "ready",
      });
    });
    const sdk = makeSdk(makeCreds(), fetch);
    const p = await sdk.project("prj_known");
    // We don't need to assert success — just confirm the plan POST body
    // carried project: "prj_known".
    await p.deploy
      .apply({ site: { patch: { delete: ["old.html"] } } })
      .catch(() => undefined);
    const planCall = calls.find((c) => c.url.endsWith("/deploy/v2/plans"));
    assert.ok(planCall, "expected a plan POST");
    const body = JSON.parse(planCall!.body as string);
    assert.equal(body.spec.project, "prj_known");
  });
});

describe("ScopedRun402 type-level guarantees (validated when tsc runs over this file)", () => {
  it("p.deploy.apply can omit project; r.deploy.apply({}) does not", async () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    const p = await sdk.project("prj_known");

    // The wrapper drops the required `project` field — this should compile.
    void (() => p.deploy.apply({ site: { patch: { delete: ["old.html"] } } }));

    // The unwrapped namespace requires `project: string`; calling it with `{}`
    // is a TS error. Use @ts-expect-error so a regression that loosened the
    // unwrapped signature would fail tsc here.
    void (() =>
      // @ts-expect-error project is required on the unwrapped namespace
      sdk.deploy.apply({}));

    // Caller-supplied project on the scoped client is fine and overrides.
    void (() => p.deploy.apply({ project: "prj_other" }));
  });
});

describe("ScopedRun402 drift protection", () => {
  // A method is "project-scoped" if its first parameter is the project id, OR
  // its options object includes project_id/project. This list enumerates the
  // methods that are intentionally NOT scoped — anything else on a wrapped
  // namespace must have a corresponding wrapper.
  const nonScopedMethods: Record<string, Set<string>> = {
    projects: new Set(["provision", "list", "getQuote", "use", "active"]),
    apps: new Set(["browse", "fork", "getApp"]),
    ai: new Set(["generateImage"]),
    deploy: new Set(),
    contracts: new Set(["read"]),
    // The following namespaces are project-scoped end-to-end:
    auth: new Set(),
    blobs: new Set(),
    domains: new Set(),
    // resolveMailbox and listMailboxes are TS-private helpers — JS runtime sees
    // them on the prototype, so list them here so the drift test ignores them.
    email: new Set(["resolveMailbox", "listMailboxes"]),
    functions: new Set(),
    secrets: new Set(),
    senderDomain: new Set(),
    subdomains: new Set(),
  };

  // Namespaces that exist on Run402 but are NOT exposed on ScopedRun402:
  const unscopedNamespaces = new Set([
    "service",
    "tier",
    "allowance",
    "auth", // auth IS scoped — but listed below
    "billing",
    "admin",
    "senderDomain",
    "blobs",
    "ai",
    "subdomains",
    "domains",
    "secrets",
    "auth",
    "contracts",
    "deploy",
    "email",
    "functions",
    "apps",
    "projects",
    "sites", // Sites class is empty — intentionally not exposed on ScopedRun402
    "ci", // CI binding lifecycle is intentionally unscoped in v1.
  ]);

  it("every project-scoped method on Run402 has a ScopedRun402 wrapper", async () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    const p = await sdk.project("prj_known");

    const namespacesToCheck: Array<keyof typeof nonScopedMethods> = [
      "projects",
      "apps",
      "ai",
      "auth",
      "blobs",
      "contracts",
      "deploy",
      "domains",
      "email",
      "functions",
      "secrets",
      "senderDomain",
      "subdomains",
    ];

    const missing: string[] = [];
    for (const nsName of namespacesToCheck) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ns = (sdk as any)[nsName];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scoped = (p as any)[nsName];
      if (!ns || !scoped) {
        missing.push(`namespace ${String(nsName)}: missing on Run402 or ScopedRun402`);
        continue;
      }
      const proto = Object.getPrototypeOf(ns);
      const methods = Object.getOwnPropertyNames(proto).filter(
        (m) => m !== "constructor" && typeof proto[m] === "function",
      );
      const exempt = nonScopedMethods[nsName] ?? new Set<string>();
      for (const method of methods) {
        // skip exempt methods (non-project-scoped)
        if (exempt.has(method)) continue;
        // skip private methods (start with `_` or shown as private at runtime)
        if (method.startsWith("_") || method.startsWith("#")) continue;
        if (typeof scoped[method] !== "function") {
          missing.push(`${String(nsName)}.${method}`);
        }
      }
    }

    assert.deepEqual(missing, [], `Missing scoped wrappers: ${missing.join(", ")}`);
  });

  it("unscopedNamespaces variable is documented but unused at runtime", () => {
    // Placeholder — keeps the intent visible without a runtime assertion the
    // test would have to update on every namespace addition.
    assert.ok(unscopedNamespaces.size > 0);
  });
});
