/**
 * Unit tests for the unified `deploy` namespace.
 *
 * Drives `r.deploy.apply` against a fake `Client` that records each
 * `request(path, opts)` and a fake `fetch` that records each S3 PUT.
 * Together they assert the full v2 wire sequence:
 *   POST /deploy/v2/plans  →  presigned PUT  →  POST /deploy/v2/plans/:id/commit
 * plus the validation paths (subdomain multi rejection, invalid spec).
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Deploy } from "./deploy.js";
import { createCiSessionCredentials } from "../ci-credentials.js";
import type { Client, RequestOptions } from "../kernel.js";
import type { CredentialsProvider } from "../credentials.js";
import type {
  CommitResponse,
  DeployEvent,
  OperationSnapshot,
  PlanResponse,
} from "./deploy.types.js";
import { ApiError, LocalError, NetworkError, Run402DeployError } from "../errors.js";
import { fileSetFromDir } from "../node/files.js";

interface RecordedRequest {
  path: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

interface RecordedPut {
  url: string;
  body: Uint8Array;
  checksum: string | null;
}

function shaHex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
function shaBase64Hex(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

interface FakeWiring {
  client: Client;
  requests: RecordedRequest[];
  puts: RecordedPut[];
  setHandler(fn: (req: RecordedRequest) => unknown): void;
  setS3Handler(fn: (url: string, body: Uint8Array, checksum: string | null) => Response): void;
}

function defaultCreds(): CredentialsProvider {
  return {
    getAuth: async () => null,
    getProject: async () => ({ anon_key: "ak", service_key: "sk" }),
  };
}

function makeWiring(credentials: CredentialsProvider = defaultCreds()): FakeWiring {
  const requests: RecordedRequest[] = [];
  const puts: RecordedPut[] = [];
  let handler: (req: RecordedRequest) => unknown = () => {
    throw new Error("no handler set");
  };
  let s3Handler: (url: string, body: Uint8Array, checksum: string | null) => Response = () =>
    new Response("", { status: 200 });

  const client: Client = {
    apiBase: "https://test.run402.test",
    request: async <T>(path: string, opts: RequestOptions): Promise<T> => {
      const auth = opts.withAuth === false ? null : await credentials.getAuth(path);
      const headers = { ...(auth ?? {}), ...(opts.headers as Record<string, string> | undefined) };
      const recorded: RecordedRequest = {
        path,
        method: opts.method,
        body: opts.body,
        headers,
      };
      requests.push(recorded);
      return handler(recorded) as T;
    },
    getProject: (id: string) => credentials.getProject(id),
    credentials,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const body = init?.body as ArrayBuffer | Uint8Array;
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body as ArrayBuffer);
      const checksum =
        (init?.headers as Record<string, string> | undefined)?.["x-amz-checksum-sha256"] ?? null;
      puts.push({ url: u, body: bytes, checksum });
      return s3Handler(u, bytes, checksum);
    }) as typeof globalThis.fetch,
  };

  return {
    client,
    requests,
    puts,
    setHandler(fn) {
      handler = fn;
    },
    setS3Handler(fn) {
      s3Handler = fn;
    },
  };
}

function noContentPlan(planId: string, operationId: string): PlanResponse {
  return {
    plan_id: planId,
    operation_id: operationId,
    base_release_id: null,
    manifest_digest: `${planId}-digest`,
    missing_content: [],
    diff: { resources: { site: { added: 1 } } },
    warnings: [],
  };
}

function readyCommit(operationId: string, releaseId: string): CommitResponse {
  return {
    operation_id: operationId,
    status: "ready",
    release_id: releaseId,
    urls: { site: `https://${releaseId}.run402.test` },
  };
}

function baseReleaseConflict(
  overrides: Partial<NonNullable<CommitResponse["error"]>> = {},
): NonNullable<CommitResponse["error"]> {
  return {
    code: "BASE_RELEASE_CONFLICT",
    message: "Another deploy activated a release after this operation was planned.",
    phase: "apply",
    resource: "release",
    retryable: true,
    safe_to_retry: true,
    ...overrides,
  };
}

function countRequests(w: FakeWiring, path: string): number {
  return w.requests.filter((req) => req.path === path).length;
}

describe("Deploy.apply (happy path)", () => {
  it("plans, uploads missing, commits, and returns the deploy result", async () => {
    const w = makeWiring();
    const html = "<html><body>hi</body></html>";
    const indexSha = shaHex(html);

    const plan: PlanResponse = {
      plan_id: "plan_abc",
      operation_id: "op_abc",
      base_release_id: null,
      manifest_digest: "deadbeef",
      missing_content: [
        { sha256: indexSha, size: html.length, present: false },
      ],
      diff: { resources: { site: { added: 1 } } },
    };
    const contentPlan = {
      plan_id: "cplan_abc",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      missing: [
        {
          sha256: indexSha,
          mode: "single",
          parts: [
            {
              part_number: 1,
              url: "https://s3.example/upload?part=1",
              byte_start: 0,
              byte_end: html.length - 1,
            },
          ],
          part_size_bytes: html.length,
          part_count: 1,
          upload_id: "u_abc",
          staging_key: "_staging/u_abc/" + indexSha,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
      entries: [{ sha256: indexSha, missing: true }],
    };
    const commit: CommitResponse = {
      operation_id: "op_abc",
      status: "ready",
      release_id: "rel_xyz",
      urls: { site: "https://prj.run402.test", deployment_id: "dpl_1" },
    };

    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") return plan;
      if (req.path === "/content/v1/plans") return contentPlan;
      if (req.path === "/storage/v1/uploads/u_abc/complete") return { status: "ok" };
      if (req.path === "/content/v1/plans/cplan_abc/commit") return {};
      if (req.path === "/deploy/v2/plans/plan_abc/commit") return commit;
      throw new Error(`unexpected path ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    const result = await deploy.apply({
      project: "prj_test",
      site: { replace: { "index.html": html } },
    });

    assert.equal(result.release_id, "rel_xyz");
    assert.equal(result.operation_id, "op_abc");
    assert.equal(result.urls.site, "https://prj.run402.test");

    // Plan body never carries inline bytes — only ContentRefs, wrapped in {spec}.
    const planReq = w.requests.find((r) => r.path === "/deploy/v2/plans");
    assert(planReq, "plan request was issued");
    const planBody = planReq.body as { spec: { project: string; site?: unknown } };
    assert.equal(planBody.spec.project, "prj_test");
    assert(JSON.stringify(planBody).indexOf(html) === -1, "no inline HTML bytes leak into plan body");

    // Content plan request: no project_id (apikey identifies project).
    const contentReq = w.requests.find((r) => r.path === "/content/v1/plans");
    assert(contentReq, "content plan request was issued");
    const contentBody = contentReq.body as { project_id?: string; content: Array<{ sha256: string; size: number }> };
    assert.equal(contentBody.project_id, undefined);
    assert.equal(contentBody.content[0].sha256, indexSha);
    assert.equal(contentBody.content[0].size, html.length);

    // S3 PUT received the correct bytes + checksum.
    assert.equal(w.puts.length, 1, "one S3 PUT for the missing file");
    assert.equal(w.puts[0].url, "https://s3.example/upload?part=1");
    assert.equal(w.puts[0].checksum, shaBase64Hex(indexSha));
    assert.equal(new TextDecoder().decode(w.puts[0].body), html);
  });

  it("uses CI Bearer auth, includes project_id for content planning, and avoids storage-complete route", async () => {
    const w = makeWiring(createCiSessionCredentials({
      projectId: "prj_test",
      accessToken: "ci-session",
    }));
    const html = "<html><body>ci</body></html>";
    const indexSha = shaHex(html);

    const plan: PlanResponse = {
      plan_id: "plan_ci",
      operation_id: "op_ci",
      base_release_id: null,
      manifest_digest: "ci",
      missing_content: [
        { sha256: indexSha, size: html.length, present: false },
      ],
      diff: { resources: { site: { added: 1 } } },
    };
    const contentPlan = {
      plan_id: "cplan_ci",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      missing: [
        {
          sha256: indexSha,
          mode: "single",
          parts: [
            {
              part_number: 1,
              url: "https://s3.example/ci-upload?part=1",
              byte_start: 0,
              byte_end: html.length - 1,
            },
          ],
          part_size_bytes: html.length,
          part_count: 1,
          upload_id: "u_ci",
          staging_key: "_staging/u_ci/" + indexSha,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
      entries: [{ sha256: indexSha, missing: true }],
    };
    const commit: CommitResponse = {
      operation_id: "op_ci",
      status: "ready",
      release_id: "rel_ci",
      urls: { site: "https://ci.run402.test" },
    };

    w.setHandler((req) => {
      assert.equal(req.headers?.Authorization, "Bearer ci-session");
      assert.equal(req.headers?.apikey, undefined);
      if (req.path === "/deploy/v2/plans") return plan;
      if (req.path === "/content/v1/plans") return contentPlan;
      if (req.path === "/content/v1/plans/cplan_ci/commit") return {};
      if (req.path === "/deploy/v2/plans/plan_ci/commit") return commit;
      if (req.path.startsWith("/storage/v1/uploads/")) {
        throw new Error("CI deploy must not call storage upload completion");
      }
      throw new Error(`unexpected path ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    const result = await deploy.apply({
      project: "prj_test",
      site: { replace: { "index.html": html } },
    });

    assert.equal(result.release_id, "rel_ci");
    const contentReq = w.requests.find((r) => r.path === "/content/v1/plans");
    assert(contentReq, "content plan request was issued");
    assert.deepEqual((contentReq.body as { project_id: string }).project_id, "prj_test");
    assert.equal(
      w.requests.some((r) => r.path.startsWith("/storage/v1/uploads/")),
      false,
    );
  });

  it("allows CI route specs to reach deploy planning for gateway scope authorization", async () => {
    for (const routes of [
      null,
      { replace: [{ pattern: "/admin", target: { type: "function", name: "admin" } }] },
    ]) {
      const w = makeWiring(createCiSessionCredentials({
        projectId: "prj_test",
        accessToken: "ci-session",
      }));
      const plan: PlanResponse = {
        plan_id: "plan_ci_routes",
        operation_id: "op_ci_routes",
        base_release_id: null,
        manifest_digest: "ci-routes",
        missing_content: [],
        diff: {},
      };
      const commit: CommitResponse = {
        operation_id: "op_ci_routes",
        status: "ready",
        release_id: "rel_ci_routes",
        urls: { site: "https://ci-routes.run402.test" },
      };

      w.setHandler((req) => {
        assert.equal(req.headers?.Authorization, "Bearer ci-session");
        if (req.path === "/deploy/v2/plans") return plan;
        if (req.path === "/deploy/v2/plans/plan_ci_routes/commit") return commit;
        throw new Error(`unexpected path ${req.path}`);
      });

      const deploy = new Deploy(w.client);
      await deploy.apply({
        project: "prj_test",
        routes,
        ...(routes === null ? { site: { patch: { delete: ["old.html"] } } } : {}),
      });

      const planReq = w.requests.find((r) => r.path === "/deploy/v2/plans");
      assert(planReq, "plan request was issued");
      assert.deepEqual((planReq.body as { spec: { routes?: unknown } }).spec.routes, routes);
      assert.equal(w.puts.length, 0);
    }
  });

  it("rejects CI-forbidden spec fields before hashing, uploading, or gateway calls", async () => {
    const cases: Array<{ spec: Record<string, unknown>; resource: string }> = [
      {
        spec: {
          project: "prj_test",
          secrets: { require: ["API_KEY"] },
          site: { patch: { delete: ["old.html"] } },
        },
        resource: "secrets",
      },
      {
        spec: { project: "prj_test", subdomains: { set: [] }, site: { patch: { delete: ["old.html"] } } },
        resource: "subdomains",
      },
      {
        spec: { project: "prj_test", checks: [], site: { patch: { delete: ["old.html"] } } },
        resource: "checks",
      },
      {
        spec: { project: "prj_test", base: { release: "empty" }, site: { patch: { delete: ["old.html"] } } },
        resource: "base",
      },
    ];

    for (const { spec, resource } of cases) {
      const w = makeWiring(createCiSessionCredentials({
        projectId: "prj_test",
        accessToken: "ci-session",
      }));
      w.setHandler(() => {
        throw new Error("network must not be called for forbidden CI specs");
      });

      const deploy = new Deploy(w.client);
      await assert.rejects(
        deploy.apply(spec as never),
        (err: unknown) =>
          err instanceof Run402DeployError &&
          err.code === "forbidden_spec_field" &&
          err.resource === resource,
      );
      assert.equal(w.requests.length, 0);
      assert.equal(w.puts.length, 0);
    }
  });

  it("rejects CI specs that would require manifest_ref", async () => {
    const w = makeWiring(createCiSessionCredentials({
      projectId: "prj_test",
      accessToken: "ci-session",
    }));
    w.setHandler(() => {
      throw new Error("network must not be called for oversized CI specs");
    });

    const deploy = new Deploy(w.client);
    await assert.rejects(
      deploy.apply({
        project: "prj_test",
        database: { expose: { huge: "x".repeat(5 * 1024 * 1024) } },
      }),
      (err: unknown) =>
        err instanceof Run402DeployError &&
        err.code === "forbidden_spec_field" &&
        err.resource === "manifest_ref",
    );
    assert.equal(w.requests.length, 0);
    assert.equal(w.puts.length, 0);
  });

  it("does not apply CI restrictions to unmarked custom Bearer providers", async () => {
    const w = makeWiring({
      async getAuth() {
        return { Authorization: "Bearer user-session" };
      },
      async getProject() {
        return { anon_key: "ak", service_key: "sk" };
      },
    });
    const plan: PlanResponse = {
      plan_id: "plan_user",
      operation_id: "op_user",
      base_release_id: null,
      manifest_digest: "user",
      missing_content: [],
      diff: {},
    };
    const commit: CommitResponse = {
      operation_id: "op_user",
      status: "ready",
      release_id: "rel_user",
      urls: { site: "https://user.run402.test" },
    };
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") return plan;
      if (req.path === "/deploy/v2/plans/plan_user/commit") return commit;
      throw new Error(`unexpected path ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    const result = await deploy.apply({
      project: "prj_test",
      secrets: { require: ["API_KEY"], delete: ["OLD_KEY"] },
    });

    assert.equal(result.release_id, "rel_user");
    const planReq = w.requests.find((r) => r.path === "/deploy/v2/plans");
    assert(planReq);
    assert.equal(planReq.headers?.Authorization, "Bearer user-session");
    assert.deepEqual((planReq.body as { spec: { secrets?: unknown } }).spec.secrets, {
      require: ["API_KEY"],
      delete: ["OLD_KEY"],
    });
  });

  it("re-deploy of unchanged content makes no S3 PUTs", async () => {
    const w = makeWiring();
    const plan: PlanResponse = {
      plan_id: "plan_2",
      operation_id: "op_2",
      base_release_id: "rel_prev",
      manifest_digest: "abcd",
      missing_content: [], // gateway reports everything present
      diff: {},
    };
    const commit: CommitResponse = {
      operation_id: "op_2",
      status: "ready",
      release_id: "rel_2",
      urls: { site: "https://prj.run402.test" },
    };
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") return plan;
      if (req.path === "/deploy/v2/plans/plan_2/commit") return commit;
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    await deploy.apply({
      project: "prj_test",
      site: { replace: { "index.html": "<h1>hi</h1>" } },
    });

    assert.equal(w.puts.length, 0, "no PUTs when nothing is missing");
  });

  it("emits content.upload.skipped for CAS-deduped (already-present) refs (#124, #134)", async () => {
    const w = makeWiring();
    const html = "<h1>cached</h1>";
    const indexSha = shaHex(html);
    const plan: PlanResponse = {
      plan_id: "plan_skip",
      operation_id: "op_skip",
      base_release_id: "rel_prev",
      manifest_digest: "abcd",
      // Gateway reports the ref as already present in CAS (dedup hit).
      missing_content: [
        { sha256: indexSha, size: html.length, present: true },
      ],
      diff: { resources: { site: { changed: 1 } } },
    };
    const commit: CommitResponse = {
      operation_id: "op_skip",
      status: "ready",
      release_id: "rel_skip",
      urls: { site: "https://prj.run402.test" },
    };
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") return plan;
      if (req.path === "/deploy/v2/plans/plan_skip/commit") return commit;
      throw new Error(`unexpected ${req.path}`);
    });

    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const deploy = new Deploy(w.client);
    await deploy.apply(
      {
        project: "prj_test",
        site: { replace: { "index.html": html } },
      },
      {
        onEvent: (ev) => {
          events.push(ev as { type: string } & Record<string, unknown>);
        },
      },
    );

    // No bytes should hit S3 — the ref is already in CAS.
    assert.equal(w.puts.length, 0, "no PUTs when ref is already present");

    // The SDK must surface the dedup hit so agents can distinguish
    // "33 files / 12 MB dedup'd" from "nothing happened".
    const skipped = events.filter((e) => e.type === "content.upload.skipped");
    assert.equal(skipped.length, 1, "one skipped event for the deduped ref");
    assert.equal(skipped[0].sha256, indexSha);
    assert.equal(skipped[0].label, "index.html");
    assert.equal(skipped[0].reason, "present");
  });

  it("polls operation when commit returns running", async () => {
    const w = makeWiring();
    const plan: PlanResponse = {
      plan_id: "plan_3",
      operation_id: "op_3",
      base_release_id: null,
      manifest_digest: "ff",
      missing_content: [],
      diff: {},
    };
    let pollCount = 0;
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") return plan;
      if (req.path === "/deploy/v2/plans/plan_3/commit") {
        return {
          operation_id: "op_3",
          status: "running",
        } satisfies CommitResponse;
      }
      if (req.path === "/deploy/v2/operations/op_3") {
        pollCount += 1;
        const snap: OperationSnapshot = {
          operation_id: "op_3",
          project_id: "prj_test",
          plan_id: "plan_3",
          status: pollCount < 2 ? "activating" : "ready",
          base_release_id: null,
          target_release_id: "rel_3",
          release_id: pollCount < 2 ? null : "rel_3",
          urls: pollCount < 2 ? null : { site: "https://prj.run402.test" },
          payment_required: null,
          error: null,
          activate_attempts: 0,
          last_activate_attempt_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        return snap;
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    const result = await deploy.apply({
      project: "prj_test",
      site: { replace: { "x.html": "x" } },
    });
    assert.equal(result.release_id, "rel_3");
    assert(pollCount >= 1, "polled at least once");
  });
});

describe("Deploy.plan", () => {
  it("passes dry_run=true and normalizes the v2 flat plan envelope", async () => {
    const w = makeWiring();
    w.setHandler((req) => {
      assert.equal(req.path, "/deploy/v2/plans?dry_run=true");
      assert.equal(req.method, "POST");
      assert.equal(
        (req.body as { idempotency_key?: unknown }).idempotency_key,
        undefined,
        "dry-run requests must not send idempotency_key",
      );
      return {
        kind: "plan_response",
        schema_version: "agent-deploy-observability.v1",
        plan_id: null,
        operation_id: null,
        base_release_id: "rel_base",
        manifest_digest: "bead",
        is_noop: false,
        summary: "1 site path added",
        warnings: [
          {
            code: "FIRST_DEPLOY",
            severity: "info",
            requires_confirmation: false,
            message: "First deploy.",
            affected: [],
          },
        ],
        expected_events: ["plan.created"],
        missing_content: [],
        payment_required: null,
        migrations: { new: [], noop: [] },
        site: {
          added: [{ path: "index.html", sha256: shaHex("hello"), content_type: "text/html" }],
          removed: [],
          changed: [],
        },
        functions: { added: [], removed: [], changed: [] },
        secrets: { added: [], removed: [] },
        subdomains: { added: [], removed: [] },
        routes: {
          added: [
            {
              pattern: "/api/*",
              kind: "prefix",
              prefix: "/api/",
              methods: null,
              target: { type: "function", name: "api" },
            },
          ],
          removed: [],
          changed: [],
        },
      };
    });

    const deploy = new Deploy(w.client);
    const { plan } = await deploy.plan(
      { project: "prj_abc", site: { replace: { "index.html": "hello" } } },
      { dryRun: true, idempotencyKey: "ignored-for-dry-run" },
    );

    assert.equal(plan.plan_id, null);
    assert.equal(plan.operation_id, null);
    assert.equal(plan.expected_events?.[0], "plan.created");
    assert.equal(plan.diff.summary, "1 site path added");
    assert.equal(plan.diff.site?.added[0]?.path, "index.html");
    assert.equal(
      (plan.diff.routes as { added: Array<{ pattern: string }> } | undefined)?.added[0]?.pattern,
      "/api/*",
    );
    assert.equal(plan.warnings[0]?.code, "FIRST_DEPLOY");
  });
});

describe("Deploy.apply (validation)", () => {
  it("rejects multi-element subdomains.set with SUBDOMAIN_MULTI_NOT_SUPPORTED", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () =>
        deploy.apply({
          project: "prj_test",
          subdomains: { set: ["a", "b"] },
        }),
      (err: unknown) =>
        err instanceof Run402DeployError &&
        (err as Run402DeployError).code === "SUBDOMAIN_MULTI_NOT_SUPPORTED",
    );
  });

  it("requires a project field", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.apply({} as never),
      (err: unknown) =>
        err instanceof Run402DeployError &&
        (err as Run402DeployError).code === "INVALID_SPEC",
    );
  });

  it("rejects unknown raw ReleaseSpec fields before normalization can drop them", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    for (const [spec, resource, pattern] of [
      [
        {
          project: "prj_test",
          project_id: "prj_other",
          site: { replace: { "index.html": "hi" } },
        },
        "spec.project_id",
        /normalizeDeployManifest/,
      ],
      [
        {
          project: "prj_test",
          subdomain: "my-app",
          site: { replace: { "index.html": "hi" } },
        },
        "spec.subdomain",
        /subdomains/,
      ],
      [
        {
          project: "prj_test",
          site: { replcae: { "index.html": "hi" } },
        },
        "site.replcae",
        /Unknown ReleaseSpec field/,
      ],
    ] as const) {
      await assert.rejects(
        () => deploy.apply(spec as never),
        (err: unknown) => {
          assert(err instanceof Run402DeployError);
          assert.equal(err.code, "INVALID_SPEC");
          assert.equal(err.phase, "validate");
          assert.equal(err.resource, resource);
          assert.match(err.message, pattern);
          return true;
        },
      );
    }
    assert.equal(w.requests.length, 0);
  });

  it("rejects no-op ReleaseSpecs before issuing gateway calls", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    const specs = [
      { project: "prj_test" },
      { project: "prj_test", base: { release: "empty" } },
      { project: "prj_test", database: { zero_downtime: true } },
      { project: "prj_test", database: { expose: {} } },
      { project: "prj_test", site: { replace: {} } },
      { project: "prj_test", site: { patch: { put: {}, delete: [] } } },
      { project: "prj_test", functions: { replace: {} } },
      { project: "prj_test", functions: { patch: { set: {}, delete: [] } } },
      { project: "prj_test", secrets: { require: [], delete: [] } },
      { project: "prj_test", subdomains: { set: [], add: [], remove: [] } },
      { project: "prj_test", routes: null },
      { project: "prj_test", checks: [] },
    ];

    for (const spec of specs) {
      await assert.rejects(
        () => deploy.apply(spec as never),
        (err: unknown) => {
          assert(err instanceof Run402DeployError);
          assert.equal(err.code, "MANIFEST_EMPTY");
          assert.equal(err.phase, "validate");
          assert.equal(err.resource, "spec");
          assert.deepEqual(err.fix, { action: "set_field", path: "site.replace" });
          return true;
        },
      );
    }
    assert.equal(w.requests.length, 0);
  });

  it("preserves routes:null when another deployable section is present", async () => {
    const w = makeWiring();
    let plannedBody: unknown;
    w.setHandler((req) => {
      assert.equal(req.path, "/deploy/v2/plans?dry_run=true");
      plannedBody = req.body;
      return {
        plan_id: null,
        operation_id: null,
        base_release_id: null,
        manifest_digest: "routes-null",
        missing_content: [],
        diff: {},
        warnings: [],
      } satisfies PlanResponse;
    });

    const deploy = new Deploy(w.client);
    await deploy.plan(
      {
        project: "prj_test",
        routes: null,
        site: { patch: { delete: ["old.html"] } },
      },
      { dryRun: true },
    );

    assert.equal((plannedBody as { spec: { routes?: unknown } }).spec.routes, null);
  });

  it("treats routes.replace=[] as deployable content and sends it", async () => {
    const w = makeWiring();
    let plannedBody: unknown;
    w.setHandler((req) => {
      assert.equal(req.path, "/deploy/v2/plans?dry_run=true");
      plannedBody = req.body;
      return {
        plan_id: null,
        operation_id: null,
        base_release_id: null,
        manifest_digest: "routes-clear",
        missing_content: [],
        diff: {},
        warnings: [],
      } satisfies PlanResponse;
    });

    const deploy = new Deploy(w.client);
    await deploy.plan(
      { project: "prj_test", routes: { replace: [] } },
      { dryRun: true },
    );

    assert.deepEqual(
      (plannedBody as { spec: { routes?: unknown } }).spec.routes,
      { replace: [] },
    );
  });

  it("accepts valid function routes and sends them to the gateway", async () => {
    const w = makeWiring();
    let plannedBody: unknown;
    w.setHandler((req) => {
      plannedBody = req.body;
      return {
        plan_id: null,
        operation_id: null,
        base_release_id: null,
        manifest_digest: "routes",
        missing_content: [],
        diff: {},
        warnings: [],
      } satisfies PlanResponse;
    });

    const deploy = new Deploy(w.client);
    await deploy.plan(
      {
        project: "prj_test",
        routes: {
          replace: [
            {
              pattern: "/api/*",
              methods: ["GET", "POST"],
              target: { type: "function", name: "api" },
            },
          ],
        },
      },
      { dryRun: true },
    );

    assert.deepEqual(
      (plannedBody as { spec: { routes?: unknown } }).spec.routes,
      {
        replace: [
          {
            pattern: "/api/*",
            methods: ["GET", "POST"],
            target: { type: "function", name: "api" },
          },
        ],
      },
    );
  });

  it("rejects the old path-keyed route map with an actionable example", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);

    await assert.rejects(
      () =>
        deploy.apply({
          project: "prj_test",
          routes: { "/api/*": { function: "api" } },
        } as never),
      (err: unknown) => {
        assert(err instanceof Run402DeployError);
        assert.equal(err.code, "INVALID_SPEC");
        assert.equal(err.resource, "routes./api/*");
        assert.match(err.message, /routes\.replace/);
        assert.match(JSON.stringify(err.fix), /"pattern":"\/api\/\*"/);
        return true;
      },
    );
    assert.equal(w.requests.length, 0);
  });

  it("rejects malformed route entries before planning", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    const badSpecs: Array<[unknown, string, RegExp]> = [
      [
        { replace: [{ pattern: "/api/*", methods: [], target: { type: "function", name: "api" } }] },
        "routes.replace.0.methods",
        /omit methods/,
      ],
      [
        { replace: [{ pattern: "/api/*", methods: ["TRACE"], target: { type: "function", name: "api" } }] },
        "routes.replace.0.methods",
        /Unsupported route method/,
      ],
      [
        { replace: [{ pattern: "/api/*", target: { type: "service", name: "api" } }] },
        "routes.replace.0.target.type",
        /function/,
      ],
      [
        { replace: [{ pattern: "/api/*", target: { type: "function" } }] },
        "routes.replace.0.target.name",
        /name is required/,
      ],
      [
        { replace: [{ pattern: "/api/*", target: { function: "api" } }] },
        "routes.replace.0.target",
        /target shorthand/,
      ],
      [
        { replace: [{ pattern: "/api/*", extra: true, target: { type: "function", name: "api" } }] },
        "routes.replace.0.extra",
        /Unknown ReleaseSpec field/,
      ],
    ];

    for (const [routes, resource, pattern] of badSpecs) {
      await assert.rejects(
        () => deploy.apply({ project: "prj_test", routes } as never),
        (err: unknown) => {
          assert(err instanceof Run402DeployError);
          assert.equal(err.code, "INVALID_SPEC");
          assert.equal(err.resource, resource);
          assert.match(err.message, pattern);
          return true;
        },
      );
    }
    assert.equal(w.requests.length, 0);
  });

  it("still accepts delete-only patch specs as deployable", async () => {
    const w = makeWiring();
    let plannedBody: unknown;
    w.setHandler((req) => {
      assert.equal(req.path, "/deploy/v2/plans?dry_run=true");
      plannedBody = req.body;
      return {
        plan_id: null,
        operation_id: null,
        base_release_id: null,
        manifest_digest: "delete-only",
        missing_content: [],
        diff: {},
        warnings: [],
      } satisfies PlanResponse;
    });

    const deploy = new Deploy(w.client);
    await deploy.plan(
      { project: "prj_test", site: { patch: { delete: ["old.html"] } } },
      { dryRun: true },
    );

    assert.equal(w.requests.length, 1);
    assert.deepEqual(
      (plannedBody as { spec: { site: unknown } }).spec.site,
      { patch: { delete: ["old.html"] } },
    );
  });

  it("rejects legacy value-bearing secrets.set and replace_all before gateway calls", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    for (const [field, resource] of [
      ["set", "secrets.set"],
      ["replace_all", "secrets.replace_all"],
    ] as const) {
      await assert.rejects(
        () =>
          deploy.apply({
            project: "prj_test",
            secrets: { [field]: { API_KEY: { value: "secret" } } } as never,
          }),
        (err: unknown) =>
          err instanceof Run402DeployError &&
          err.code === "INVALID_SPEC" &&
          err.resource === resource &&
          /secrets API/.test(err.message),
      );
    }
    assert.equal(w.requests.length, 0);
  });

  it("validates value-free secret declarations before gateway calls", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () =>
        deploy.apply({
          project: "prj_test",
          secrets: { require: ["bad-key"] },
        }),
      (err: unknown) =>
        err instanceof Run402DeployError &&
        err.code === "INVALID_SPEC" &&
        err.resource === "secrets.require",
    );
    await assert.rejects(
      () =>
        deploy.apply({
          project: "prj_test",
          secrets: { require: ["API_KEY"], delete: ["API_KEY"] },
        }),
      (err: unknown) =>
        err instanceof Run402DeployError &&
        err.code === "INVALID_SPEC" &&
        err.resource === "secrets",
    );
    assert.equal(w.requests.length, 0);
  });

  it("requires sql or sql_ref on a migration", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () =>
        deploy.apply({
          project: "prj_test",
          database: { migrations: [{ id: "001_init" }] },
        }),
      (err: unknown) =>
        err instanceof Run402DeployError &&
        (err as Run402DeployError).code === "INVALID_SPEC",
    );
  });
});

describe("Deploy.apply (plan warnings)", () => {
  it("emits warnings and aborts before upload or commit by default", async () => {
    const w = makeWiring();
    const events: DeployEvent[] = [];
    const plan: PlanResponse = {
      plan_id: "plan_warn",
      operation_id: "op_warn",
      base_release_id: null,
      manifest_digest: "warn",
      missing_content: [],
      diff: {},
      warnings: [
        {
          code: "MISSING_REQUIRED_SECRET",
          severity: "high",
          requires_confirmation: true,
          message: "OPENAI_API_KEY is required but missing",
          affected: ["OPENAI_API_KEY"],
        },
      ],
    };
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") return plan;
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    await assert.rejects(
      () =>
        deploy.apply(
          {
            project: "prj_test",
            secrets: { require: ["OPENAI_API_KEY"] },
          },
          { onEvent: (event) => events.push(event) },
        ),
      (err: unknown) => {
        assert(err instanceof Run402DeployError);
        assert.equal(err.code, "MISSING_REQUIRED_SECRET");
        assert.equal(err.phase, "plan");
        assert.deepEqual(err.body, { warnings: plan.warnings });
        return true;
      },
    );
    assert.deepEqual(w.requests.map((r) => r.path), ["/deploy/v2/plans"]);
    assert.equal(events.some((event) => event.type === "plan.warnings"), true);
  });

  it("continues with allowWarnings and preserves warnings on the result", async () => {
    const w = makeWiring();
    const warnings = [
      {
        code: "UNUSUAL_DELETE",
        severity: "medium" as const,
        requires_confirmation: true,
        message: "Deleting OLD_KEY",
        affected: ["OLD_KEY"],
      },
    ];
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") {
        return {
          plan_id: "plan_warn_ok",
          operation_id: "op_warn_ok",
          base_release_id: null,
          manifest_digest: "warn-ok",
          missing_content: [],
          diff: {},
          warnings,
        } satisfies PlanResponse;
      }
      if (req.path === "/deploy/v2/plans/plan_warn_ok/commit") {
        return {
          operation_id: "op_warn_ok",
          status: "ready",
          release_id: "rel_warn_ok",
          urls: {},
        } satisfies CommitResponse;
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    const result = await deploy.apply(
      {
        project: "prj_test",
        secrets: { delete: ["OLD_KEY"] },
      },
      { allowWarnings: true },
    );
    assert.equal(result.release_id, "rel_warn_ok");
    assert.deepEqual(result.warnings, warnings);
  });
});

describe("Deploy.apply (network errors)", () => {
  it("translates NetworkError thrown during plan into Run402DeployError NETWORK_ERROR retryable", async () => {
    const w = makeWiring();
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") {
        throw new NetworkError(
          "simulated DNS failure",
          new Error("ENOTFOUND"),
          "planning deploy",
        );
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    await assert.rejects(
      () =>
        deploy.apply({
          project: "prj_test",
          site: { replace: { "index.html": "<h1>hi</h1>" } },
        }),
      (err: unknown) => {
        assert(err instanceof Run402DeployError, "is Run402DeployError");
        const e = err as Run402DeployError;
        assert.equal(e.code, "NETWORK_ERROR", "code is NETWORK_ERROR");
        assert.equal(e.retryable, true, "retryable is true");
        return true;
      },
    );
  });
});

describe("Deploy.apply (validate-phase structured error context)", () => {
  it("populates phase/resource/fix when the spec is not an object", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.apply(null as never),
      (err: unknown) => {
        assert(err instanceof Run402DeployError);
        const e = err as Run402DeployError;
        assert.equal(e.code, "INVALID_SPEC");
        assert.equal(e.phase, "validate");
        assert.equal(e.resource, "spec");
        assert.deepEqual(e.fix, { action: "set_field", path: "" });
        return true;
      },
    );
  });

  it("populates phase/resource/fix when project is missing", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.apply({} as never),
      (err: unknown) => {
        assert(err instanceof Run402DeployError);
        const e = err as Run402DeployError;
        assert.equal(e.code, "INVALID_SPEC");
        assert.equal(e.phase, "validate");
        assert.equal(e.resource, "spec.project");
        assert.deepEqual(e.fix, { action: "set_field", path: "project" });
        return true;
      },
    );
  });

  it("populates phase/resource/fix when subdomains.set has multiple entries", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () =>
        deploy.apply({
          project: "prj_test",
          subdomains: { set: ["a", "b"] },
        }),
      (err: unknown) => {
        assert(err instanceof Run402DeployError);
        const e = err as Run402DeployError;
        assert.equal(e.code, "SUBDOMAIN_MULTI_NOT_SUPPORTED");
        assert.equal(e.phase, "validate");
        assert.equal(e.resource, "subdomains.set");
        assert.deepEqual(e.fix, { action: "set_field", path: "subdomains.set" });
        return true;
      },
    );
  });

  it("populates phase/resource/fix when a migration is missing its id", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () =>
        deploy.apply({
          project: "prj_test",
          database: { migrations: [{ sql: "SELECT 1" } as never] },
        }),
      (err: unknown) => {
        assert(err instanceof Run402DeployError);
        const e = err as Run402DeployError;
        assert.equal(e.code, "INVALID_SPEC");
        assert.equal(e.phase, "validate");
        assert.equal(e.resource, "database.migrations");
        assert(e.fix !== null);
        assert.equal(e.fix!.action, "set_field");
        assert.equal(typeof e.fix!.path, "string");
        return true;
      },
    );
  });

  it("populates phase/resource/fix when a migration has neither sql nor sql_ref", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () =>
        deploy.apply({
          project: "prj_test",
          database: { migrations: [{ id: "001_init" }] },
        }),
      (err: unknown) => {
        assert(err instanceof Run402DeployError);
        const e = err as Run402DeployError;
        assert.equal(e.code, "INVALID_SPEC");
        assert.equal(e.phase, "validate");
        assert.equal(e.resource, "database.migrations.001_init");
        assert.deepEqual(e.fix, {
          action: "set_field",
          path: "database.migrations.001_init.sql",
        });
        return true;
      },
    );
  });
});

describe("Deploy.apply (byte source normalization)", () => {
  it("hashes a string source and includes it as a ContentRef in the plan", async () => {
    const w = makeWiring();
    const html = "<html>hi</html>";
    const expected = shaHex(html);

    let plannedSpec: unknown;
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") {
        plannedSpec = req.body;
        return {
          plan_id: "p",
          operation_id: "o",
          base_release_id: null,
          manifest_digest: "x",
          missing_content: [],
          diff: {},
        } satisfies PlanResponse;
      }
      if (req.path === "/deploy/v2/plans/p/commit") {
        return {
          operation_id: "o",
          status: "ready",
          release_id: "r",
          urls: { site: "https://x" },
        } satisfies CommitResponse;
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    await deploy.apply({
      project: "prj_test",
      site: { replace: { "index.html": html } },
    });

    const sent = JSON.stringify(plannedSpec);
    assert(sent.includes(expected), "manifest contains the SHA-256 of the file content");
  });

  it("hashes Uint8Array sources", async () => {
    const w = makeWiring();
    const bytes = new Uint8Array([0xff, 0x00, 0x42]);
    const expected = createHash("sha256").update(Buffer.from(bytes)).digest("hex");

    let plannedSpec: unknown;
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") {
        plannedSpec = req.body;
        return {
          plan_id: "p",
          operation_id: "o",
          base_release_id: null,
          manifest_digest: "x",
          missing_content: [],
          diff: {},
        } satisfies PlanResponse;
      }
      if (req.path.endsWith("/commit")) {
        return {
          operation_id: "o",
          status: "ready",
          release_id: "r",
          urls: {},
        } satisfies CommitResponse;
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    await deploy.apply({
      project: "prj_test",
      site: { replace: { "data.bin": bytes } },
    });
    assert(JSON.stringify(plannedSpec).includes(expected));
  });

  it("hashes FsFileSource sources from disk", async () => {
    const w = makeWiring();
    const root = mkdtempSync(join(tmpdir(), "run402-deploy-fs-"));
    try {
      const html = "<title>fs</title>";
      writeFileSync(join(root, "index.html"), html);
      const expected = shaHex(html);

      let plannedSpec: unknown;
      w.setHandler((req) => {
        if (req.path === "/deploy/v2/plans") {
          plannedSpec = req.body;
          return {
            plan_id: "p",
            operation_id: "o",
            base_release_id: null,
            manifest_digest: "x",
            missing_content: [],
            diff: {},
          } satisfies PlanResponse;
        }
        if (req.path.endsWith("/commit")) {
          return {
            operation_id: "o",
            status: "ready",
            release_id: "r",
            urls: {},
          } satisfies CommitResponse;
        }
        throw new Error(`unexpected ${req.path}`);
      });

      const deploy = new Deploy(w.client);
      const fileSet = await fileSetFromDir(root);
      await deploy.apply({
        project: "prj_test",
        site: { replace: fileSet },
      });
      assert(JSON.stringify(plannedSpec).includes(expected));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Deploy.apply (manifest-ref escape hatch)", () => {
  it("uploads the manifest as CAS when the spec exceeds the inline 5 MB body limit", async () => {
    const w = makeWiring();

    // Build a spec whose JSON envelope exceeds 5 MB. Bytes are not in the
    // manifest — the wire body only carries ContentRefs (sha256 + size +
    // content_type) plus path keys. To exceed 5 MB we need either many
    // entries or very long path strings; we use very long paths to keep
    // the hashing cost (one SHA-256 per unique content) low.
    const replace: Record<string, string> = {};
    const filler = "x";
    const longPathPad = "a".repeat(800);
    for (let i = 0; i < 7000; i++) {
      replace[`${longPathPad}/file-${i.toString().padStart(6, "0")}.txt`] = filler;
    }

    let casPlanCalled = false;
    let casCommitCalled = false;
    let planRefSeen = false;
    w.setHandler((req) => {
      if (req.path === "/content/v1/plans") {
        casPlanCalled = true;
        return {
          plan_id: "cplan_1",
          missing: [
            {
              sha256: "0".repeat(64),
              size: 1,
              mode: "single",
              parts: [
                {
                  part_number: 1,
                  url: "https://s3.example/manifest",
                  byte_start: 0,
                  byte_end: 0,
                },
              ],
              part_size_bytes: 1,
              part_count: 1,
              upload_id: "u_manifest",
              staging_key: "_staging/u_manifest/" + "0".repeat(64),
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
            },
          ],
          entries: [{ sha256: "0".repeat(64), missing: true }],
        };
      }
      if (req.path === "/storage/v1/uploads/u_manifest/complete") {
        return { status: "ok" };
      }
      if (req.path.startsWith("/content/v1/plans/") && req.path.endsWith("/commit")) {
        casCommitCalled = true;
        return {};
      }
      if (req.path === "/deploy/v2/plans") {
        const body = req.body as { manifest_ref?: unknown; site?: unknown };
        planRefSeen = "manifest_ref" in body;
        return {
          plan_id: "p",
          operation_id: "o",
          base_release_id: null,
          manifest_digest: "x",
          missing_content: [],
          diff: {},
        } satisfies PlanResponse;
      }
      if (req.path === "/deploy/v2/plans/p/commit") {
        return {
          operation_id: "o",
          status: "ready",
          release_id: "r",
          urls: {},
        } satisfies CommitResponse;
      }
      throw new Error(`unexpected ${req.path}`);
    });

    // Match every CAS upload regardless of part sha (fixture is content-only).
    w.setS3Handler(() => new Response("", { status: 200 }));

    const deploy = new Deploy(w.client);
    await deploy.apply({
      project: "prj_test",
      site: { replace },
    });

    assert(casPlanCalled, "manifest-ref path called /content/v1/plans");
    assert(casCommitCalled, "manifest-ref path called /content/v1/plans/:id/commit");
    assert(planRefSeen, "deploy plan body uses manifest_ref instead of inline manifest");
  });
});

describe("Deploy.resume (input validation + error wrapping)", () => {
  it("throws Run402DeployError without issuing any request when operationId is empty", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.resume(""),
      (err: unknown) =>
        err instanceof Run402DeployError &&
        (err as Run402DeployError).code === "OPERATION_NOT_FOUND" &&
        (err as Run402DeployError).retryable === false,
    );
    assert.equal(w.requests.length, 0, "no HTTP request issued for empty operationId");
  });

  it("throws Run402DeployError without issuing any request when operationId is not prefixed with op_", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.resume("notop_xx"),
      (err: unknown) =>
        err instanceof Run402DeployError &&
        (err as Run402DeployError).code === "OPERATION_NOT_FOUND" &&
        (err as Run402DeployError).retryable === false,
    );
    assert.equal(w.requests.length, 0, "no HTTP request issued for invalid prefix");
  });

  it("translates a gateway 404 with {code:'operation_not_found'} into a Run402DeployError", async () => {
    const w = makeWiring();
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/operations/op_does_not_exist/resume") {
        throw new ApiError(
          "API error while resuming deploy operation (HTTP 404)",
          404,
          { code: "operation_not_found", message: "operation not found" },
          "resuming deploy operation",
        );
      }
      throw new Error(`unexpected ${req.path}`);
    });
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.resume("op_does_not_exist"),
      (err: unknown) =>
        err instanceof Run402DeployError &&
        (err as Run402DeployError).code === "OPERATION_NOT_FOUND",
    );
  });
});

describe("Deploy CI operation routes", () => {
  it("uses CI Bearer auth without apikey for status, list, events, and resume", async () => {
    const w = makeWiring(createCiSessionCredentials({
      projectId: "prj_test",
      accessToken: "ci-session",
    }));
    const ready: OperationSnapshot = {
      operation_id: "op_ci",
      plan_id: "plan_ci",
      status: "ready",
      phase: "ready",
      release_id: "rel_ci",
      urls: { site: "https://ci.run402.test" },
    } as OperationSnapshot;
    w.setHandler((req) => {
      assert.equal(req.headers?.Authorization, "Bearer ci-session");
      assert.equal(req.headers?.apikey, undefined);
      if (req.path === "/deploy/v2/operations/op_ci") return ready;
      if (req.path === "/deploy/v2/operations") return { operations: [ready], cursor: null };
      if (req.path === "/deploy/v2/operations/op_ci/events") return { events: [] };
      if (req.path === "/deploy/v2/operations/op_ci/resume") return ready;
      throw new Error(`unexpected path ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    assert.deepEqual(await deploy.status("op_ci", { project: "prj_test" }), ready);
    assert.equal((await deploy.list({ project: "prj_test" })).operations.length, 1);
    assert.deepEqual(await deploy.events("op_ci", { project: "prj_test" }), { events: [] });
    assert.equal((await deploy.resume("op_ci", { project: "prj_test" })).release_id, "rel_ci");
  });
});

describe("Deploy.apply (gateway error translation)", () => {
  it("preserves operation_id and plan_id from the gateway error body (#127)", async () => {
    // Regression for GH-127: when the gateway returns a structured deploy
    // error with operation_id/plan_id in the body (e.g.
    // MIGRATION_CHECKSUM_MISMATCH), the resulting Run402DeployError must
    // surface them — even though the call site for the plan request passes
    // null for both ids (it has no other source of truth at that moment).
    const w = makeWiring();
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") {
        throw new ApiError(
          "Migration checksum mismatch",
          409,
          {
            code: "MIGRATION_CHECKSUM_MISMATCH",
            message: "Migration checksum mismatch",
            operation_id: "op_from_body_123",
            plan_id: "plan_from_body_456",
          },
          "planning deploy",
        );
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    let caught: unknown;
    try {
      await deploy.apply({
        project: "prj_test",
        database: { migrations: [{ id: "001_init", sql: "select 1" }] },
      });
      assert.fail("expected deploy.apply to reject");
    } catch (err) {
      caught = err;
    }

    assert(caught instanceof Run402DeployError, "error is Run402DeployError");
    const e = caught as Run402DeployError;
    assert.equal(e.code, "MIGRATION_CHECKSUM_MISMATCH");
    assert.equal(e.operationId, "op_from_body_123");
    assert.equal(e.planId, "plan_from_body_456");
  });

  it("translates canonical deploy envelopes and exposes inherited projections", async () => {
    const w = makeWiring();
    const canonical = {
      message: "Migration failed.",
      code: "MIGRATION_FAILED",
      category: "deploy",
      retryable: false,
      safe_to_retry: true,
      mutation_state: "rolled_back",
      trace_id: "trc_dep",
      details: {
        phase: "migrate",
        resource: "database.migrations.001_init",
        operation_id: "op_1",
        plan_id: "plan_1",
        rolled_back: true,
      },
      next_actions: [{ action: "edit_migration", path: "database.migrations.001_init" }],
    };
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans/plan_1/commit") {
        return {
          operation_id: "op_1",
          status: "failed",
          error: canonical,
        } satisfies CommitResponse;
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.commit("plan_1"),
      (err: unknown) => {
        assert.ok(err instanceof Run402DeployError);
        const e = err as Run402DeployError;
        assert.equal(e.code, "MIGRATION_FAILED");
        assert.equal(e.phase, "migrate");
        assert.equal(e.resource, "database.migrations.001_init");
        assert.equal(e.retryable, false);
        assert.equal(e.safeToRetry, true);
        assert.equal(e.mutationState, "rolled_back");
        assert.equal(e.traceId, "trc_dep");
        assert.equal(e.operationId, "op_1");
        assert.equal(e.planId, "plan_1");
        assert.equal(e.rolledBack, true);
        assert.deepEqual(e.details, canonical.details);
        assert.deepEqual(e.nextActions, canonical.next_actions);
        return true;
      },
    );
  });

  it("lets legacy top-level deploy fields win while canonical details fill gaps", async () => {
    const w = makeWiring();
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") {
        throw new ApiError(
          "Gateway rejected migration",
          409,
          {
            code: "MIGRATION_CHECKSUM_MISMATCH",
            message: "Migration checksum mismatch",
            phase: "validate",
            resource: "database.migrations.top",
            retryable: false,
            safe_to_retry: true,
            mutation_state: "none",
            trace_id: "trc_mix",
            details: {
              phase: "migrate",
              resource: "database.migrations.detail",
              operation_id: "op_detail",
              plan_id: "plan_detail",
              rolled_back: true,
            },
          },
          "planning deploy",
        );
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    await assert.rejects(
      () =>
        deploy.apply({
          project: "prj_test",
          database: { migrations: [{ id: "001_init", sql: "select 1" }] },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Run402DeployError);
        const e = err as Run402DeployError;
        assert.equal(e.code, "MIGRATION_CHECKSUM_MISMATCH");
        assert.equal(e.phase, "validate");
        assert.equal(e.resource, "database.migrations.top");
        assert.equal(e.operationId, "op_detail");
        assert.equal(e.planId, "plan_detail");
        assert.equal(e.safeToRetry, true);
        assert.equal(e.mutationState, "none");
        assert.equal(e.traceId, "trc_mix");
        assert.equal(e.rolledBack, true);
        return true;
      },
    );
  });

  it("projects canonical fields from nested gateway error wrappers", async () => {
    const w = makeWiring();
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") {
        throw new ApiError(
          "Gateway rejected deploy",
          503,
          {
            error: {
              code: "MIGRATE_GATE_ACTIVE",
              message: "Migration gate active.",
              retryable: true,
              operation_id: "op_nested",
            },
            category: "deploy",
            safe_to_retry: true,
            mutation_state: "not_started",
            trace_id: "trc_nested",
            details: { phase: "migrate-gate", plan_id: "plan_nested" },
            next_actions: [{ action: "retry" }],
          },
          "planning deploy",
        );
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    await assert.rejects(
      () =>
        deploy.apply({
          project: "prj_test",
          database: { migrations: [{ id: "001_init", sql: "select 1" }] },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Run402DeployError);
        const e = err as Run402DeployError;
        assert.equal(e.code, "MIGRATE_GATE_ACTIVE");
        assert.equal(e.category, "deploy");
        assert.equal(e.retryable, true);
        assert.equal(e.safeToRetry, true);
        assert.equal(e.mutationState, "not_started");
        assert.equal(e.traceId, "trc_nested");
        assert.equal(e.operationId, "op_nested");
        assert.equal(e.planId, "plan_nested");
        assert.deepEqual(e.nextActions, [{ action: "retry" }]);
        return true;
      },
    );
  });

  it("branches on terse deploy codes without parsing English messages", async () => {
    const w = makeWiring();
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans/plan_missing/commit") {
        throw new ApiError(
          "HTTP 404",
          404,
          { code: "PLAN_NOT_FOUND" },
          "committing deploy",
        );
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.commit("plan_missing"),
      (err: unknown) => {
        assert.ok(err instanceof Run402DeployError);
        const e = err as Run402DeployError;
        assert.equal(e.code, "PLAN_NOT_FOUND");
        assert.equal(e.message, "Deploy error: PLAN_NOT_FOUND");
        assert.equal(e.planId, "plan_missing");
        return true;
      },
    );
  });

  it("recognizes canonical migrate-gate active codes from HTTP errors", async () => {
    const w = makeWiring();
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans/plan_gate/commit") {
        throw new ApiError(
          "HTTP 503",
          503,
          {
            code: "MIGRATE_GATE_ACTIVE",
            retryable: true,
            safe_to_retry: true,
            mutation_state: "not_started",
            trace_id: "trc_gate",
            details: { phase: "migrate-gate" },
          },
          "committing deploy",
        );
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.commit("plan_gate"),
      (err: unknown) => {
        assert.ok(err instanceof Run402DeployError);
        const e = err as Run402DeployError;
        assert.equal(e.code, "MIGRATE_GATE_ACTIVE");
        assert.equal(e.phase, "migrate-gate");
        assert.equal(e.retryable, true);
        assert.equal(e.safeToRetry, true);
        assert.equal(e.mutationState, "not_started");
        assert.equal(e.traceId, "trc_gate");
        return true;
      },
    );
  });
});

describe("Deploy.apply (safe race retry)", () => {
  it("replans after BASE_RELEASE_CONFLICT with safe_to_retry=true and succeeds", async () => {
    const w = makeWiring();
    const events: DeployEvent[] = [];
    let planCalls = 0;

    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") {
        planCalls += 1;
        return planCalls === 1
          ? noContentPlan("plan_conflict", "op_conflict")
          : noContentPlan("plan_retry", "op_retry");
      }
      if (req.path === "/deploy/v2/plans/plan_conflict/commit") {
        return {
          operation_id: "op_conflict",
          status: "failed",
          error: baseReleaseConflict({
            operation_id: "op_conflict",
            plan_id: "plan_conflict",
          }),
        } satisfies CommitResponse;
      }
      if (req.path === "/deploy/v2/plans/plan_retry/commit") {
        return readyCommit("op_retry", "rel_retry");
      }
      throw new Error(`unexpected path ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    const result = await deploy.apply(
      { project: "prj_test", site: { replace: { "index.html": "hello" } } },
      { maxRetries: 1, onEvent: (event) => events.push(event) },
    );

    assert.equal(result.release_id, "rel_retry");
    assert.equal(planCalls, 2, "retry issued a fresh plan request");
    assert.equal(countRequests(w, "/deploy/v2/plans/plan_conflict/commit"), 1);
    assert.equal(countRequests(w, "/deploy/v2/plans/plan_retry/commit"), 1);
    const retry = events.find((event) => event.type === "deploy.retry");
    assert.deepEqual(retry, {
      type: "deploy.retry",
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 2,
      delayMs: retry && retry.type === "deploy.retry" ? retry.delayMs : -1,
      code: "BASE_RELEASE_CONFLICT",
      phase: "apply",
      resource: "release",
      operationId: "op_conflict",
      planId: "plan_conflict",
      message: "Another deploy activated a release after this operation was planned.",
    });
    assert.ok(
      retry && retry.type === "deploy.retry" && retry.delayMs >= 250,
      "retry event includes a bounded delay",
    );
  });

  it("uses the default budget of two retries after the initial attempt", async () => {
    const w = makeWiring();
    let planCalls = 0;
    const events: DeployEvent[] = [];

    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") {
        planCalls += 1;
        return noContentPlan(`plan_${planCalls}`, `op_${planCalls}`);
      }
      if (req.path === "/deploy/v2/plans/plan_1/commit") {
        return {
          operation_id: "op_1",
          status: "failed",
          error: baseReleaseConflict({ operation_id: "op_1", plan_id: "plan_1" }),
        } satisfies CommitResponse;
      }
      if (req.path === "/deploy/v2/plans/plan_2/commit") {
        return {
          operation_id: "op_2",
          status: "failed",
          error: baseReleaseConflict({ operation_id: "op_2", plan_id: "plan_2" }),
        } satisfies CommitResponse;
      }
      if (req.path === "/deploy/v2/plans/plan_3/commit") {
        return readyCommit("op_3", "rel_default_retry");
      }
      throw new Error(`unexpected path ${req.path}`);
    });

    const result = await new Deploy(w.client).apply(
      { project: "prj_test", site: { replace: { "index.html": "hello" } } },
      { onEvent: (event) => events.push(event) },
    );

    assert.equal(result.release_id, "rel_default_retry");
    assert.equal(planCalls, 3);
    assert.equal(events.filter((event) => event.type === "deploy.retry").length, 2);
  });

  it("does not retry without safe_to_retry=true, with only retryable=true, or for non-allowlisted codes", async () => {
    const cases: Array<{
      name: string;
      error: NonNullable<CommitResponse["error"]>;
    }> = [
      {
        name: "safe_false",
        error: baseReleaseConflict({ safe_to_retry: false }),
      },
      {
        name: "safe_absent",
        error: (() => {
          const err = baseReleaseConflict();
          delete err.safe_to_retry;
          return err;
        })(),
      },
      {
        name: "retryable_only",
        error: baseReleaseConflict({ retryable: true, safe_to_retry: false }),
      },
      {
        name: "non_allowlisted_safe_error",
        error: {
          code: "MIGRATE_GATE_ACTIVE",
          message: "Migration gate active.",
          phase: "migrate-gate",
          retryable: true,
          safe_to_retry: true,
        },
      },
    ];

    for (const { name, error } of cases) {
      const w = makeWiring();
      w.setHandler((req) => {
        if (req.path === "/deploy/v2/plans") return noContentPlan(`plan_${name}`, `op_${name}`);
        if (req.path === `/deploy/v2/plans/plan_${name}/commit`) {
          return { operation_id: `op_${name}`, status: "failed", error } satisfies CommitResponse;
        }
        throw new Error(`unexpected path ${req.path}`);
      });

      await assert.rejects(
        () =>
          new Deploy(w.client).apply({
            project: "prj_test",
            site: { replace: { "index.html": "hello" } },
          }),
        (err: unknown) => err instanceof Run402DeployError,
      );
      assert.equal(countRequests(w, "/deploy/v2/plans"), 1, `${name}: no retry`);
    }
  });

  it("retries omitted/current bases but not pinned release_id or empty bases", async () => {
    const specs: Array<{
      name: string;
      spec: Parameters<Deploy["apply"]>[0];
      expectedPlans: number;
    }> = [
      {
        name: "omitted",
        spec: { project: "prj_test", site: { replace: { "index.html": "hello" } } },
        expectedPlans: 2,
      },
      {
        name: "current",
        spec: {
          project: "prj_test",
          base: { release: "current" },
          site: { replace: { "index.html": "hello" } },
        },
        expectedPlans: 2,
      },
      {
        name: "pinned",
        spec: {
          project: "prj_test",
          base: { release_id: "rel_pinned" },
          site: { replace: { "index.html": "hello" } },
        },
        expectedPlans: 1,
      },
      {
        name: "empty",
        spec: {
          project: "prj_test",
          base: { release: "empty" },
          site: { replace: { "index.html": "hello" } },
        },
        expectedPlans: 1,
      },
    ];

    for (const { name, spec, expectedPlans } of specs) {
      const w = makeWiring();
      let planCalls = 0;
      w.setHandler((req) => {
        if (req.path === "/deploy/v2/plans") {
          planCalls += 1;
          return noContentPlan(`plan_${name}_${planCalls}`, `op_${name}_${planCalls}`);
        }
        if (req.path === `/deploy/v2/plans/plan_${name}_1/commit`) {
          return {
            operation_id: `op_${name}_1`,
            status: "failed",
            error: baseReleaseConflict({
              operation_id: `op_${name}_1`,
              plan_id: `plan_${name}_1`,
            }),
          } satisfies CommitResponse;
        }
        if (req.path === `/deploy/v2/plans/plan_${name}_2/commit`) {
          return readyCommit(`op_${name}_2`, `rel_${name}`);
        }
        throw new Error(`unexpected path ${req.path}`);
      });

      if (expectedPlans === 2) {
        const result = await new Deploy(w.client).apply(spec, { maxRetries: 1 });
        assert.equal(result.release_id, `rel_${name}`);
      } else {
        await assert.rejects(
          () => new Deploy(w.client).apply(spec, { maxRetries: 1 }),
          (err: unknown) => err instanceof Run402DeployError,
        );
      }
      assert.equal(planCalls, expectedPlans, `${name}: expected plan count`);
    }
  });

  it("honors maxRetries=0 and custom exhausted budgets", async () => {
    const disabled = makeWiring();
    disabled.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") return noContentPlan("plan_disabled", "op_disabled");
      if (req.path === "/deploy/v2/plans/plan_disabled/commit") {
        return {
          operation_id: "op_disabled",
          status: "failed",
          error: baseReleaseConflict(),
        } satisfies CommitResponse;
      }
      throw new Error(`unexpected path ${req.path}`);
    });

    await assert.rejects(
      () =>
        new Deploy(disabled.client).apply(
          { project: "prj_test", site: { replace: { "index.html": "hello" } } },
          { maxRetries: 0 },
        ),
      (err: unknown) => err instanceof Run402DeployError,
    );
    assert.equal(countRequests(disabled, "/deploy/v2/plans"), 1);

    const exhausted = makeWiring();
    let planCalls = 0;
    exhausted.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") {
        planCalls += 1;
        return noContentPlan(`plan_exhausted_${planCalls}`, `op_exhausted_${planCalls}`);
      }
      if (req.path === `/deploy/v2/plans/plan_exhausted_${planCalls}/commit`) {
        return {
          operation_id: `op_exhausted_${planCalls}`,
          status: "failed",
          error: baseReleaseConflict({
            operation_id: `op_exhausted_${planCalls}`,
            plan_id: `plan_exhausted_${planCalls}`,
          }),
        } satisfies CommitResponse;
      }
      throw new Error(`unexpected path ${req.path}`);
    });

    await assert.rejects(
      () =>
        new Deploy(exhausted.client).apply(
          { project: "prj_test", site: { replace: { "index.html": "hello" } } },
          { maxRetries: 1 },
        ),
      (err: unknown) => {
        assert.ok(err instanceof Run402DeployError);
        assert.equal(err.code, "BASE_RELEASE_CONFLICT");
        assert.equal(err.operationId, "op_exhausted_2");
        assert.equal(err.planId, "plan_exhausted_2");
        assert.equal(err.attempts, 2);
        assert.equal(err.maxRetries, 1);
        assert.equal(err.lastRetryCode, "BASE_RELEASE_CONFLICT");
        const json = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
        assert.equal(json["attempts"], 2);
        assert.equal(json["maxRetries"], 1);
        assert.equal(json["lastRetryCode"], "BASE_RELEASE_CONFLICT");
        const body = err.body as Record<string, unknown>;
        assert.equal(body["attempts"], 2);
        assert.equal(body["max_retries"], 1);
        assert.equal(body["last_retry_code"], "BASE_RELEASE_CONFLICT");
        return true;
      },
    );
    assert.equal(planCalls, 2);
  });

  it("rejects invalid maxRetries before planning", async () => {
    for (const maxRetries of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      const w = makeWiring();
      const deploy = new Deploy(w.client);
      await assert.rejects(
        () =>
          deploy.apply(
            { project: "prj_test", site: { replace: { "index.html": "hello" } } },
            { maxRetries },
          ),
        (err: unknown) =>
          err instanceof Run402DeployError &&
          err.code === "INVALID_SPEC" &&
          err.resource === "maxRetries",
      );
      assert.equal(w.requests.length, 0, `${maxRetries}: no request before validation`);
    }
  });

  it("swallows retry event callback failures and still retries", async () => {
    const w = makeWiring();
    let planCalls = 0;
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") {
        planCalls += 1;
        return noContentPlan(`plan_cb_${planCalls}`, `op_cb_${planCalls}`);
      }
      if (req.path === "/deploy/v2/plans/plan_cb_1/commit") {
        return {
          operation_id: "op_cb_1",
          status: "failed",
          error: baseReleaseConflict(),
        } satisfies CommitResponse;
      }
      if (req.path === "/deploy/v2/plans/plan_cb_2/commit") {
        return readyCommit("op_cb_2", "rel_cb");
      }
      throw new Error(`unexpected path ${req.path}`);
    });

    const result = await new Deploy(w.client).apply(
      { project: "prj_test", site: { replace: { "index.html": "hello" } } },
      {
        maxRetries: 1,
        onEvent(event) {
          if (event.type === "deploy.retry") throw new Error("buggy logger");
        },
      },
    );
    assert.equal(result.release_id, "rel_cb");
    assert.equal(planCalls, 2);
  });

  it("keeps start() and low-level commit() out of the automatic apply retry loop", async () => {
    const started = makeWiring();
    started.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") return noContentPlan("plan_start", "op_start");
      if (req.path === "/deploy/v2/plans/plan_start/commit") {
        return {
          operation_id: "op_start",
          status: "failed",
          error: baseReleaseConflict(),
        } satisfies CommitResponse;
      }
      throw new Error(`unexpected path ${req.path}`);
    });

    const op = await new Deploy(started.client).start({
      project: "prj_test",
      site: { replace: { "index.html": "hello" } },
    });
    await assert.rejects(
      () => op.result(),
      (err: unknown) => err instanceof Run402DeployError,
    );
    assert.equal(countRequests(started, "/deploy/v2/plans"), 1);

    const committed = makeWiring();
    committed.setHandler((req) => {
      if (req.path === "/deploy/v2/plans/plan_commit/commit") {
        return {
          operation_id: "op_commit",
          status: "failed",
          error: baseReleaseConflict(),
        } satisfies CommitResponse;
      }
      throw new Error(`unexpected path ${req.path}`);
    });

    await assert.rejects(
      () => new Deploy(committed.client).commit("plan_commit"),
      (err: unknown) => err instanceof Run402DeployError,
    );
    assert.equal(countRequests(committed, "/deploy/v2/plans/plan_commit/commit"), 1);
  });
});

// ─── GH-140: retry retryable CONTENT_UPLOAD_FAILED with backoff ─────────────
//
// When `uploadOne` throws Run402DeployError with `retryable: true` (e.g. a
// transient network drop on a presigned-PUT), the SDK must retry with
// exponential backoff up to MAX_ATTEMPTS (1 initial + 2 retries). A single
// network blip should not fail the whole deploy. See GH-140.
describe("Deploy.apply (retry on retryable CONTENT_UPLOAD_FAILED)", () => {
  // Helper that wires a deploy with one missing file and lets the test
  // control how each PUT attempt resolves.
  function setupSingleMissing(w: ReturnType<typeof makeWiring>): {
    indexSha: string;
    htmlBytes: string;
  } {
    const html = "<html><body>retry-me</body></html>";
    const indexSha = shaHex(html);

    const plan: PlanResponse = {
      plan_id: "plan_retry",
      operation_id: "op_retry",
      base_release_id: null,
      manifest_digest: "deadbeef",
      missing_content: [{ sha256: indexSha, size: html.length, present: false }],
      diff: { resources: { site: { added: 1 } } },
    };
    const contentPlan = {
      plan_id: "cplan_retry",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      missing: [
        {
          sha256: indexSha,
          mode: "single",
          parts: [
            {
              part_number: 1,
              url: "https://s3.example/upload?part=1",
              byte_start: 0,
              byte_end: html.length - 1,
            },
          ],
          part_size_bytes: html.length,
          part_count: 1,
          upload_id: "u_retry",
          staging_key: "_staging/u_retry/" + indexSha,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
      entries: [{ sha256: indexSha, missing: true }],
    };
    const commit: CommitResponse = {
      operation_id: "op_retry",
      status: "ready",
      release_id: "rel_retry",
      urls: { site: "https://prj.run402.test", deployment_id: "dpl_retry" },
    };
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") return plan;
      if (req.path === "/content/v1/plans") return contentPlan;
      if (req.path === "/storage/v1/uploads/u_retry/complete") return { status: "ok" };
      if (req.path === "/content/v1/plans/cplan_retry/commit") return {};
      if (req.path === "/deploy/v2/plans/plan_retry/commit") return commit;
      throw new Error(`unexpected path ${req.path}`);
    });
    return { indexSha, htmlBytes: html };
  }

  it("retries a single transient PUT failure and completes successfully", async () => {
    const w = makeWiring();
    const { htmlBytes } = setupSingleMissing(w);

    let putAttempts = 0;
    w.setS3Handler(() => {
      putAttempts += 1;
      if (putAttempts === 1) {
        // Simulate a transient network drop. fetch() throwing here causes
        // putToS3() to wrap it in Run402DeployError(retryable: true).
        throw new TypeError("network drop");
      }
      return new Response("", { status: 200 });
    });

    const deploy = new Deploy(w.client);
    const result = await deploy.apply({
      project: "prj_test",
      site: { replace: { "index.html": htmlBytes } },
    });

    assert.equal(result.release_id, "rel_retry");
    assert.equal(putAttempts, 2, "exactly one retry happened (2 PUT attempts total)");
    assert.equal(w.puts.length, 2, "fake fetch saw 2 PUT calls");
  });

  it("gives up after MAX_ATTEMPTS and surfaces the last Run402DeployError", async () => {
    const w = makeWiring();
    setupSingleMissing(w);

    let putAttempts = 0;
    w.setS3Handler(() => {
      putAttempts += 1;
      throw new TypeError("network drop");
    });

    const deploy = new Deploy(w.client);
    await assert.rejects(
      () =>
        deploy.apply({
          project: "prj_test",
          site: { replace: { "index.html": "<html><body>retry-me</body></html>" } },
        }),
      (err: unknown) =>
        err instanceof Run402DeployError &&
        (err as Run402DeployError).code === "CONTENT_UPLOAD_FAILED" &&
        (err as Run402DeployError).retryable === true,
    );
    assert.equal(putAttempts, 3, "stopped at MAX_ATTEMPTS=3 (1 initial + 2 retries)");
  });
});

describe("Deploy.apply (commit.phase done events between transitions)", () => {
  it("emits commit.phase done before the next phase's started, plus done on terminal ready (#135)", async () => {
    const w = makeWiring();
    const html = "<html>phase</html>";
    const indexSha = shaHex(html);

    const plan: PlanResponse = {
      plan_id: "plan_phase",
      operation_id: "op_phase",
      base_release_id: null,
      manifest_digest: "phase",
      missing_content: [],
      diff: {},
    };
    // Simulate the operation walking through staging → migrating → activating → ready.
    const sequence: OperationSnapshot[] = [
      { operation_id: "op_phase", status: "staging", plan_id: "plan_phase" } as OperationSnapshot,
      { operation_id: "op_phase", status: "migrating", plan_id: "plan_phase" } as OperationSnapshot,
      { operation_id: "op_phase", status: "activating", plan_id: "plan_phase" } as OperationSnapshot,
      {
        operation_id: "op_phase",
        status: "ready",
        plan_id: "plan_phase",
        release_id: "rel_phase",
        urls: { site: "https://prj.run402.test" },
      } as OperationSnapshot,
    ];
    let snapshotIndex = 0;
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") return plan;
      if (req.path === "/deploy/v2/plans/plan_phase/commit") {
        return {
          operation_id: "op_phase",
          status: "staging",
          release_id: null,
          urls: null,
        } as unknown as CommitResponse;
      }
      if (req.path.startsWith("/deploy/v2/operations/op_phase")) {
        const snap = sequence[Math.min(snapshotIndex, sequence.length - 1)];
        snapshotIndex += 1;
        return snap;
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const events: DeployEvent[] = [];
    const deploy = new Deploy(w.client);
    await deploy.apply(
      { project: "prj_test", site: { replace: { "index.html": html } } },
      { onEvent: (e) => events.push(e) },
    );

    // Filter to the commit.phase events (the validate-started one is emitted
    // by apply() itself before the snapshot sequence kicks in).
    const phaseEvents = events
      .filter((e): e is Extract<DeployEvent, { type: "commit.phase" }> => e.type === "commit.phase")
      .map((e) => `${e.phase}:${e.status}`);

    // The exact lead-in includes validate:started; what we lock down is the
    // done/started pairing across stage → migrate → activate → ready.
    assert(phaseEvents.includes("stage:started"), "stage:started emitted");
    assert(phaseEvents.includes("stage:done"), "stage:done emitted between stage and migrate");
    assert(phaseEvents.includes("migrate:started"), "migrate:started emitted");
    assert(phaseEvents.includes("migrate:done"), "migrate:done emitted between migrate and activate");
    assert(phaseEvents.includes("activate:started"), "activate:started emitted");
    assert(phaseEvents.includes("activate:done"), "activate:done emitted before terminal ready");

    // Done must precede the next started for the same transition.
    const stageDoneIdx = phaseEvents.indexOf("stage:done");
    const migrateStartedIdx = phaseEvents.indexOf("migrate:started");
    assert(stageDoneIdx < migrateStartedIdx, "stage:done precedes migrate:started");
    const migrateDoneIdx = phaseEvents.indexOf("migrate:done");
    const activateStartedIdx = phaseEvents.indexOf("activate:started");
    assert(migrateDoneIdx < activateStartedIdx, "migrate:done precedes activate:started");
  });
});

describe("Deploy.start (events iterator lifecycle)", () => {
  it("late iteration after op.result() drains buffered events and exits cleanly (GH-138)", async () => {
    const w = makeWiring();
    const html = "<html>hi</html>";

    const plan: PlanResponse = {
      plan_id: "plan_late",
      operation_id: "op_late",
      base_release_id: null,
      manifest_digest: "feed",
      missing_content: [],
      diff: {},
    };
    const commit: CommitResponse = {
      operation_id: "op_late",
      status: "ready",
      release_id: "rel_late",
      urls: { site: "https://prj.run402.test" },
    };
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") return plan;
      if (req.path === "/deploy/v2/plans/plan_late/commit") return commit;
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    const op = await deploy.start({
      project: "prj_test",
      site: { replace: { "index.html": html } },
    });

    // Drive the deploy to completion before iterating events.
    const result = await op.result();
    assert.equal(result.release_id, "rel_late");

    // Now consume events post-completion. The iterator MUST yield the
    // buffered events (including the terminal "ready") and then exit
    // cleanly within a deterministic window — not hang.
    const collected: string[] = [];
    const consume = (async () => {
      for await (const ev of op.events()) {
        collected.push(ev.type);
      }
    })();

    const HANG_MS = 500;
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), HANG_MS),
    );
    const winner = await Promise.race([
      consume.then(() => "done" as const),
      timeout,
    ]);

    assert.notEqual(
      winner,
      "timeout",
      "events() iterator hung after late iteration — never delivered done signal",
    );
    assert(
      collected.includes("ready"),
      "buffered terminal 'ready' event was delivered before iterator closed",
    );
  });

  it("late iteration after a failed deploy exits cleanly", async () => {
    const w = makeWiring();
    const plan: PlanResponse = {
      plan_id: "plan_fail",
      operation_id: "op_fail",
      base_release_id: null,
      manifest_digest: "dead",
      missing_content: [],
      diff: {},
    };
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") return plan;
      if (req.path === "/deploy/v2/plans/plan_fail/commit") {
        return {
          operation_id: "op_fail",
          status: "failed",
          release_id: null,
          urls: null,
          error: { code: "INTERNAL_ERROR", message: "boom" },
        } as unknown as CommitResponse;
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    const op = await deploy.start({
      project: "prj_test",
      site: { replace: { "x.html": "x" } },
    });

    await assert.rejects(() => op.result());

    const consume = (async () => {
      for await (const _ev of op.events()) {
        /* drain */
      }
    })();

    const HANG_MS = 500;
    const winner = await Promise.race([
      consume.then(() => "done" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), HANG_MS)),
    ]);
    assert.notEqual(winner, "timeout", "events() iterator hung after failed deploy");
  });
});

describe("Deploy.list", () => {
  it("GETs /deploy/v2/operations with the project's apikey", async () => {
    const w = makeWiring();
    const sample = {
      operations: [
        {
          operation_id: "op_1",
          project_id: "prj_test",
          plan_id: "plan_1",
          status: "ready",
          base_release_id: null,
          target_release_id: "rel_1",
          release_id: "rel_1",
          urls: { project: "https://prj.run402.test" },
          payment_required: null,
          error: null,
          activate_attempts: 1,
          last_activate_attempt_at: null,
          created_at: "2026-04-29T00:00:00Z",
          updated_at: "2026-04-29T00:00:01Z",
        },
      ],
      cursor: null,
    };
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/operations") return sample;
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    const result = await deploy.list({ project: "prj_test" });

    assert.equal(result.operations.length, 1);
    assert.equal(result.operations[0].operation_id, "op_1");
    assert.equal(result.cursor, null);
    assert.equal(w.requests.length, 1);
    assert.equal(w.requests[0].path, "/deploy/v2/operations");
  });

  it("forwards limit as a query string", async () => {
    const w = makeWiring();
    w.setHandler(() => ({ operations: [], cursor: null }));
    const deploy = new Deploy(w.client);
    await deploy.list({ project: "prj_test", limit: 5 });
    assert.equal(w.requests[0].path, "/deploy/v2/operations?limit=5");
  });

  it("accepts a bare projectId string and issues the same request as the options form", async () => {
    const projectLookups: string[] = [];
    const wiringFor = (): FakeWiring => {
      const w = makeWiring();
      const orig = w.client.getProject;
      (w.client as { getProject: (id: string) => Promise<unknown> }).getProject = async (
        id: string,
      ) => {
        projectLookups.push(id);
        return orig(id);
      };
      return w;
    };

    const w = wiringFor();
    w.setHandler(() => ({ operations: [], cursor: null }));
    const deploy = new Deploy(w.client);
    await deploy.list("prj_test");
    assert.equal(w.requests.length, 1);
    assert.equal(w.requests[0].path, "/deploy/v2/operations");
    assert.equal(w.requests[0].headers?.apikey, "ak");

    const w2 = wiringFor();
    w2.setHandler(() => ({ operations: [], cursor: null }));
    const deploy2 = new Deploy(w2.client);
    await deploy2.list({ project: "prj_test" });
    assert.equal(w2.requests.length, 1);
    assert.equal(w2.requests[0].path, w.requests[0].path);
    assert.equal(w2.requests[0].headers?.apikey, w.requests[0].headers?.apikey);

    assert.equal(projectLookups.length, 2);
    assert.equal(projectLookups[0], "prj_test", "bare-string form looked up project by id");
    assert.equal(projectLookups[1], "prj_test", "options form looked up project by id");
  });

  it("accepts a bare projectId string with limit forwarded via the options form", async () => {
    const w = makeWiring();
    w.setHandler(() => ({ operations: [], cursor: null }));
    const deploy = new Deploy(w.client);
    await deploy.list({ project: "prj_test", limit: 5 });
    assert.equal(w.requests[0].path, "/deploy/v2/operations?limit=5");
    assert.equal(w.requests[0].headers?.apikey, "ak");
  });

  it("rejects undefined input with a LocalError mentioning project id", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.list(undefined as unknown as string),
      (err: unknown) =>
        err instanceof LocalError && /project id/i.test((err as LocalError).message),
    );
    assert.equal(w.requests.length, 0);
  });

  it("rejects an empty options object with a LocalError mentioning project id", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.list({} as { project: string }),
      (err: unknown) =>
        err instanceof LocalError && /project id/i.test((err as LocalError).message),
    );
    assert.equal(w.requests.length, 0);
  });

  it("rejects an empty string projectId with a LocalError", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.list(""),
      (err: unknown) =>
        err instanceof LocalError && /project id/i.test((err as LocalError).message),
    );
    assert.equal(w.requests.length, 0);
  });
});

describe("Deploy.events", () => {
  it("GETs /deploy/v2/operations/:id/events and returns the event list", async () => {
    const w = makeWiring();
    const sample = {
      events: [
        { type: "plan.started" },
        { type: "ready", releaseId: "rel_1", urls: { project: "https://prj.run402.test" } },
      ],
    };
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/operations/op_42/events") return sample;
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    const result = await deploy.events("op_42", { project: "prj_test" });

    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].type, "plan.started");
    const last = result.events[1] as Extract<DeployEvent, { type: "ready" }>;
    assert.equal(last.releaseId, "rel_1");
  });

  it("rejects empty operation id without issuing a request", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.events("", { project: "prj_test" }),
      (err: unknown) =>
        err instanceof Run402DeployError &&
        (err as Run402DeployError).code === "OPERATION_NOT_FOUND",
    );
    assert.equal(w.requests.length, 0);
  });

  it("rejects non-`op_`-prefixed operation id without issuing a request", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.events("notop_xx", { project: "prj_test" }),
      (err: unknown) =>
        err instanceof Run402DeployError &&
        (err as Run402DeployError).code === "OPERATION_NOT_FOUND",
    );
    assert.equal(w.requests.length, 0);
  });

  it("translates a gateway 404 into a structured Run402DeployError", async () => {
    const w = makeWiring();
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/operations/op_missing/events") {
        throw new ApiError(
          "API error while fetching deploy events (HTTP 404)",
          404,
          { code: "operation_not_found", message: "operation not found" },
          "fetching deploy events",
        );
      }
      throw new Error(`unexpected ${req.path}`);
    });
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.events("op_missing", { project: "prj_test" }),
      (err: unknown) =>
        err instanceof Run402DeployError &&
        (err as Run402DeployError).code === "OPERATION_NOT_FOUND",
    );
  });
});

describe("Deploy release observability", () => {
  const inventory = {
    kind: "release_inventory",
    schema_version: "agent-deploy-observability.v1",
    release_id: "rel_1",
    project_id: "prj_test",
    parent_id: null,
    status: "active",
    manifest_digest: "abc123",
    created_at: "2026-04-29T00:00:00Z",
    created_by: "0xabc",
    activated_at: "2026-04-29T00:01:00Z",
    superseded_at: null,
    operation_id: null,
    plan_id: null,
    events_url: null,
    effective: true,
    state_kind: "effective",
    site: { paths: [], totals: undefined },
    functions: [],
    secrets: { keys: [] },
    subdomains: { names: [] },
    migrations_applied: [],
  };

  it("fetches a release inventory with project apikey auth and encoded query values", async () => {
    const w = makeWiring();
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/releases/rel_%2Fweird?site_limit=123") return inventory;
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    const result = await deploy.getRelease({
      project: "prj_test",
      releaseId: "rel_/weird",
      siteLimit: 123,
    });

    assert.equal(result.release_id, "rel_1");
    assert.equal(w.requests[0].headers?.apikey, "ak");
  });

  it("supports the string release id overload when a project is supplied", async () => {
    const w = makeWiring();
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/releases/rel_1") return inventory;
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    await deploy.getRelease("rel_1", { project: "prj_test" });

    assert.equal(w.requests[0].headers?.apikey, "ak");
  });

  it("rejects legacy getRelease(releaseId) without issuing a request", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.getRelease("rel_1"),
      (err: unknown) =>
        err instanceof LocalError && /project id/i.test((err as LocalError).message),
    );
    assert.equal(w.requests.length, 0);
  });

  it("fetches the active release inventory with site_limit", async () => {
    const w = makeWiring();
    const activeInventory = { ...inventory, release_id: "rel_active", state_kind: "current_live" };
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/releases/active?site_limit=7") return activeInventory;
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    const result = await deploy.getActiveRelease({ project: "prj_test", siteLimit: 7 });

    assert.equal(result.release_id, "rel_active");
    assert.equal(result.state_kind, "current_live");
    assert.equal(w.requests[0].headers?.apikey, "ak");
  });

  it("diffs release targets with encoded selectors, limit, and project apikey auth", async () => {
    const w = makeWiring();
    const diff = {
      kind: "release_diff",
      schema_version: "agent-deploy-observability.v1",
      from_release_id: null,
      to_release_id: "rel_2",
      is_noop: false,
      summary: "1 site path added",
      warnings: [],
      migrations: { applied_between_releases: ["001_init"] },
      site: { added: [], removed: [], changed: [] },
      functions: { added: [], removed: [], changed: [] },
      secrets: { added: [], removed: [] },
      subdomains: { added: [], removed: [] },
    };
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/releases/diff?from=empty&to=rel_%2Ftwo&limit=9") {
        return diff;
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    const result = await deploy.diff({
      project: "prj_test",
      from: "empty",
      to: "rel_/two",
      limit: 9,
    });

    assert.equal(result.migrations.applied_between_releases[0], "001_init");
    assert.equal(w.requests[0].headers?.apikey, "ak");
  });

  it("rejects legacy diff({ from, to }) without issuing a request", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.diff({ from: "empty", to: "active" }),
      (err: unknown) =>
        err instanceof LocalError && /project id/i.test((err as LocalError).message),
    );
    assert.equal(w.requests.length, 0);
  });
});
