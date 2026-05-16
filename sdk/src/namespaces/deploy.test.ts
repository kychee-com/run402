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
import {
  buildDeployResolveSummary,
  normalizeDeployResolveRequest,
} from "./deploy.types.js";
import type {
  CommitResponse,
  DeployEvent,
  DeployResolveResponse,
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

  it("completes non-CI multipart content uploads with part ETags", async () => {
    const w = makeWiring();
    const html = "<html><body>multipart-content</body></html>";
    const indexSha = shaHex(html);
    const splitAt = 18;

    const plan: PlanResponse = {
      plan_id: "plan_multipart",
      operation_id: "op_multipart",
      base_release_id: null,
      manifest_digest: "multipart",
      missing_content: [
        { sha256: indexSha, size: html.length, present: false },
      ],
      diff: { resources: { site: { added: 1 } } },
      warnings: [],
    };
    const contentPlan = {
      plan_id: "cplan_multipart",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      missing: [
        {
          sha256: indexSha,
          mode: "multipart",
          parts: [
            {
              part_number: 1,
              url: "https://s3.example/multipart?part=1",
              byte_start: 0,
              byte_end: splitAt - 1,
            },
            {
              part_number: 2,
              url: "https://s3.example/multipart?part=2",
              byte_start: splitAt,
              byte_end: html.length - 1,
            },
          ],
          part_size_bytes: splitAt,
          part_count: 2,
          upload_id: "u_multipart",
          staging_key: "_staging/u_multipart/" + indexSha,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
      entries: [{ sha256: indexSha, missing: true }],
    };
    const commit: CommitResponse = {
      operation_id: "op_multipart",
      status: "ready",
      release_id: "rel_multipart",
      urls: { site: "https://prj.run402.test" },
    };

    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") return plan;
      if (req.path === "/content/v1/plans") return contentPlan;
      if (req.path === "/storage/v1/uploads/u_multipart/complete") return { status: "ok" };
      if (req.path === "/content/v1/plans/cplan_multipart/commit") return {};
      if (req.path === "/deploy/v2/plans/plan_multipart/commit") return commit;
      throw new Error(`unexpected path ${req.path}`);
    });
    w.setS3Handler((url) => {
      const etag = url.endsWith("part=1") ? "\"etag-part-1\"" : "\"etag-part-2\"";
      return new Response("", { status: 200, headers: { etag } });
    });

    const deploy = new Deploy(w.client);
    await deploy.apply({
      project: "prj_test",
      site: { replace: { "index.html": html } },
    });

    assert.equal(w.puts.length, 2, "one PUT per multipart part");
    const completeReq = w.requests.find(
      (r) => r.path === "/storage/v1/uploads/u_multipart/complete",
    );
    assert(completeReq, "multipart upload completion request was issued");
    assert.deepEqual(completeReq.body, {
      parts: [
        { part_number: 1, etag: "\"etag-part-1\"" },
        { part_number: 2, etag: "\"etag-part-2\"" },
      ],
    });
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

  it("allows CI site.public_paths to reach deploy planning", async () => {
    const w = makeWiring(createCiSessionCredentials({
      projectId: "prj_test",
      accessToken: "ci-session",
    }));
    const plan: PlanResponse = {
      plan_id: "plan_ci_public_paths",
      operation_id: "op_ci_public_paths",
      base_release_id: null,
      manifest_digest: "ci-public-paths",
      missing_content: [],
      diff: {},
    };
    const commit: CommitResponse = {
      operation_id: "op_ci_public_paths",
      status: "ready",
      release_id: "rel_ci_public_paths",
      urls: { site: "https://ci-public-paths.run402.test" },
    };

    w.setHandler((req) => {
      assert.equal(req.headers?.Authorization, "Bearer ci-session");
      if (req.path === "/deploy/v2/plans") return plan;
      if (req.path === "/deploy/v2/plans/plan_ci_public_paths/commit") return commit;
      throw new Error(`unexpected path ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    await deploy.apply({
      project: "prj_test",
      site: {
        public_paths: {
          mode: "explicit",
          replace: {
            "/events": { asset: "events.html", cache_class: "html" },
          },
        },
      },
    });

    const planReq = w.requests.find((r) => r.path === "/deploy/v2/plans");
    assert(planReq, "plan request was issued");
    assert.deepEqual((planReq.body as { spec: { site?: unknown } }).spec.site, {
      public_paths: {
        mode: "explicit",
        replace: {
          "/events": { asset: "events.html", cache_class: "html" },
        },
      },
    });
  });

  it("preserves gateway CI errors for nested site.public_paths", async () => {
    const w = makeWiring(createCiSessionCredentials({
      projectId: "prj_test",
      accessToken: "ci-session",
    }));
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") {
        throw new ApiError(
          "Gateway rejected CI public paths",
          403,
          {
            code: "CI_ROUTE_SCOPE_DENIED",
            message: "CI binding cannot declare this public path.",
            resource: "site.public_paths.replace./admin",
          },
          "planning deploy",
        );
      }
      throw new Error(`unexpected path ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    await assert.rejects(
      () =>
        deploy.apply({
          project: "prj_test",
          site: {
            public_paths: {
              mode: "explicit",
              replace: { "/admin": { asset: "admin.html" } },
            },
          },
        }),
      (err: unknown) => {
        assert(err instanceof Run402DeployError);
        assert.equal(err.code, "CI_ROUTE_SCOPE_DENIED");
        assert.equal(err.resource, "site.public_paths.replace./admin");
        assert.match(err.message, /cannot declare this public path/);
        return true;
      },
    );
    assert.equal(w.requests.length, 1);
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

describe("Deploy.apply (tier function preflight)", () => {
  it("rejects timeout caps before deploy planning with structured BAD_FIELD details", async () => {
    const w = makeWiring();
    w.setHandler((req) => {
      if (req.path === "/tiers/v1/status") {
        return {
          wallet: "0xtest",
          tier: "prototype",
          lease_started_at: "2026-05-01T00:00:00.000Z",
          lease_expires_at: "2026-05-08T00:00:00.000Z",
          active: true,
          pool_usage: {
            projects: 1,
            total_api_calls: 0,
            total_storage_bytes: 0,
            api_calls_limit: 500_000,
            storage_bytes_limit: 1_073_741_824,
          },
          function_limits: {
            max_function_timeout_seconds: 10,
            max_function_memory_mb: 128,
            max_scheduled_functions: 1,
            min_cron_interval_minutes: 15,
          },
        };
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    await assert.rejects(
      () =>
        deploy.apply({
          project: "prj_test",
          functions: {
            replace: {
              api: {
                source: "export default { fetch() { return new Response('ok') } };",
                config: { timeoutSeconds: 20 },
              },
            },
          },
        }),
      (err: unknown) => {
        assert(err instanceof Run402DeployError);
        assert.equal(err.code, "BAD_FIELD");
        assert.equal(err.status, null);
        assert.equal(err.phase, "validate");
        assert.equal(err.resource, "functions.api.config.timeoutSeconds");
        assert.deepEqual(err.details, {
          field: "functions.api.config.timeoutSeconds",
          value: 20,
          tier: "prototype",
          limit_source: "tier_status",
          tier_max: 10,
          max_function_timeout_seconds: 10,
        });
        return true;
      },
    );

    assert.equal(countRequests(w, "/tiers/v1/status"), 1);
    assert.equal(countRequests(w, "/deploy/v2/plans"), 0);
    assert.equal(w.puts.length, 0);
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

  it("adds a client warning for GET-only wildcard function routes", async () => {
    const w = makeWiring();
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans?dry_run=true") {
        return {
          plan_id: null,
          operation_id: null,
          base_release_id: "rel_base",
          manifest_digest: "route-lint",
          missing_content: [],
          diff: {},
          warnings: [],
        } satisfies PlanResponse;
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    const { plan } = await deploy.plan(
      {
        project: "prj_test",
        routes: {
          replace: [
            {
              pattern: "/admin/*",
              methods: ["GET", "HEAD"],
              target: { type: "function", name: "admin" },
            },
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

    assert.equal(plan.warnings.length, 1);
    assert.equal(plan.warnings[0]?.code, "WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS");
    assert.equal(plan.warnings[0]?.requires_confirmation, true);
    assert.deepEqual(plan.warnings[0]?.affected, ["/admin/*"]);
  });

  it("suppresses only acknowledged read-only wildcard route warnings", async () => {
    const w = makeWiring();
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans?dry_run=true") {
        return {
          plan_id: null,
          operation_id: null,
          base_release_id: "rel_base",
          manifest_digest: "route-lint-ack",
          missing_content: [],
          diff: {},
          warnings: [],
        } satisfies PlanResponse;
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    const { plan } = await deploy.plan(
      {
        project: "prj_test",
        routes: {
          replace: [
            {
              pattern: "/share/*",
              methods: ["GET"],
              target: { type: "function", name: "share" },
              acknowledge_readonly: true,
            },
            {
              pattern: "/admin/*",
              methods: ["GET", "HEAD"],
              target: { type: "function", name: "admin" },
            },
          ],
        },
      },
      { dryRun: true },
    );

    assert.equal(plan.warnings.length, 1);
    assert.equal(plan.warnings[0]?.code, "WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS");
    assert.deepEqual(plan.warnings[0]?.affected, ["/admin/*"]);
  });

  it("normalizes site file bytes while preserving explicit public paths", async () => {
    const w = makeWiring();
    const html = "<h1>events</h1>";
    const expected = shaHex(html);
    let plannedBody: unknown;
    w.setHandler((req) => {
      assert.equal(req.path, "/deploy/v2/plans?dry_run=true");
      plannedBody = req.body;
      return {
        plan_id: null,
        operation_id: null,
        base_release_id: null,
        manifest_digest: "public-paths",
        missing_content: [],
        diff: {},
        warnings: [],
      } satisfies PlanResponse;
    });

    const deploy = new Deploy(w.client);
    const { byteReaders } = await deploy.plan(
      {
        project: "prj_test",
        site: {
          replace: { "events.html": html },
          public_paths: {
            mode: "explicit",
            replace: {
              "/events": { asset: "events.html", cache_class: "html" },
            },
          },
        },
      },
      { dryRun: true },
    );

    const site = (plannedBody as {
      spec: {
        site: {
          replace: Record<string, { sha256: string; size: number }>;
          public_paths: unknown;
        };
      };
    }).spec.site;
    assert.equal(site.replace["events.html"].sha256, expected);
    assert.equal(JSON.stringify(plannedBody).includes(html), false);
    assert.deepEqual(site.public_paths, {
      mode: "explicit",
      replace: {
        "/events": { asset: "events.html", cache_class: "html" },
      },
    });
    assert.equal(byteReaders.size, 1);
  });

  it("treats public-path-only site specs as deployable without creating byte readers", async () => {
    const w = makeWiring();
    let plannedBody: unknown;
    w.setHandler((req) => {
      assert.equal(req.path, "/deploy/v2/plans?dry_run=true");
      plannedBody = req.body;
      return {
        plan_id: null,
        operation_id: null,
        base_release_id: null,
        manifest_digest: "public-path-only",
        missing_content: [],
        diff: {},
        warnings: [],
      } satisfies PlanResponse;
    });

    const deploy = new Deploy(w.client);
    const { byteReaders } = await deploy.plan(
      {
        project: "prj_test",
        site: {
          public_paths: { mode: "explicit", replace: {} },
        },
      },
      { dryRun: true },
    );

    assert.deepEqual(
      (plannedBody as { spec: { site?: unknown } }).spec.site,
      { public_paths: { mode: "explicit", replace: {} } },
    );
    assert.equal(byteReaders.size, 0);
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

  it("allows top-level $schema metadata without sending it to deploy planning", async () => {
    const w = makeWiring();
    let plannedBody: unknown;
    w.setHandler((req) => {
      assert.equal(req.path, "/deploy/v2/plans?dry_run=true");
      plannedBody = req.body;
      return {
        plan_id: null,
        operation_id: null,
        base_release_id: null,
        manifest_digest: "schema-metadata",
        missing_content: [],
        diff: {},
        warnings: [],
      } satisfies PlanResponse;
    });

    const deploy = new Deploy(w.client);
    await deploy.plan(
      {
        $schema: "https://run402.com/schemas/release-spec.v1.json",
        project: "prj_test",
        site: { replace: { "index.html": "hi" } },
      },
      { dryRun: true },
    );

    assert.equal(JSON.stringify(plannedBody).includes("$schema"), false);
  });

  it("rejects invalid function config integers before issuing gateway calls", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    const specs = [
      {
        project: "prj_test",
        functions: {
          replace: {
            hello: {
              source: "export default async () => new Response('ok')",
              config: { timeoutSeconds: 1.5 },
            },
          },
        },
      },
      {
        project: "prj_test",
        functions: {
          patch: {
            set: {
              hello: {
                source: "export default async () => new Response('ok')",
                config: { memoryMb: "256" },
              },
            },
          },
        },
      },
      {
        project: "prj_test",
        functions: {
          replace: {
            hello: {
              source: "export default async () => new Response('ok')",
              config: { timeoutSeconds: Number.POSITIVE_INFINITY },
            },
          },
        },
      },
    ];

    for (const spec of specs) {
      await assert.rejects(
        () => deploy.apply(spec as never),
        (err: unknown) => {
          assert(err instanceof Run402DeployError);
          assert.equal(err.code, "INVALID_SPEC");
          assert.equal(err.phase, "validate");
          assert.match(err.message, /positive safe JSON integer/);
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

  it("rejects malformed site.public_paths shapes before issuing gateway calls", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    const cases: Array<[unknown, string, RegExp]> = [
      [
        { mode: "explicit", patch: {} },
        "site.public_paths.patch",
        /Unknown ReleaseSpec field/,
      ],
      [
        { mode: "explicit" },
        "site.public_paths.replace",
        /requires a complete public_paths\.replace map/,
      ],
      [
        { mode: "implicit", replace: { "/events": { asset: "events.html" } } },
        "site.public_paths.replace",
        /not allowed when mode is implicit/,
      ],
      [
        { mode: "explicit", replace: { "/events": "events.html" } },
        "site.public_paths.replace./events",
        /must be an object/,
      ],
      [
        { mode: "explicit", replace: { "/events": { cache_class: "html" } } },
        "site.public_paths.replace./events.asset",
        /asset must be a non-empty/,
      ],
      [
        { mode: "explicit", replace: { "/events": { asset: "events.html", headers: {} } } },
        "site.public_paths.replace./events.headers",
        /Unknown ReleaseSpec field/,
      ],
    ];

    for (const [publicPaths, resource, pattern] of cases) {
      await assert.rejects(
        () =>
          deploy.plan(
            {
              project: "prj_test",
              site: { public_paths: publicPaths as never },
            },
            { dryRun: true },
          ),
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

  it("accepts implicit site public paths as deployable content", async () => {
    const w = makeWiring();
    let plannedBody: unknown;
    w.setHandler((req) => {
      plannedBody = req.body;
      return {
        plan_id: null,
        operation_id: null,
        base_release_id: null,
        manifest_digest: "implicit-public-paths",
        missing_content: [],
        diff: {},
        warnings: [],
      } satisfies PlanResponse;
    });

    const deploy = new Deploy(w.client);
    await deploy.plan(
      {
        project: "prj_test",
        site: { public_paths: { mode: "implicit" } },
      },
      { dryRun: true },
    );

    assert.deepEqual(
      (plannedBody as { spec: { site?: unknown } }).spec.site,
      { public_paths: { mode: "implicit" } },
    );
    assert.equal(w.requests.length, 1);
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

  it("accepts exact static route targets and sends them to the gateway", async () => {
    const w = makeWiring();
    let plannedBody: unknown;
    w.setHandler((req) => {
      plannedBody = req.body;
      return {
        plan_id: null,
        operation_id: null,
        base_release_id: null,
        manifest_digest: "static-route",
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
              pattern: "/events",
              methods: ["GET", "HEAD"],
              target: { type: "static", file: "events.html" },
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
            pattern: "/events",
            methods: ["GET", "HEAD"],
            target: { type: "static", file: "events.html" },
          },
        ],
      },
    );
  });

  it("preserves same-pattern mixed-method function and static route entries", async () => {
    const w = makeWiring();
    let plannedBody: unknown;
    w.setHandler((req) => {
      plannedBody = req.body;
      return {
        plan_id: null,
        operation_id: null,
        base_release_id: null,
        manifest_digest: "mixed-method-routes",
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
              pattern: "/login",
              methods: ["GET"],
              target: { type: "static", file: "login.html" },
            },
            {
              pattern: "/login",
              methods: ["POST"],
              target: { type: "function", name: "login_submit" },
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
            pattern: "/login",
            methods: ["GET"],
            target: { type: "static", file: "login.html" },
          },
          {
            pattern: "/login",
            methods: ["POST"],
            target: { type: "function", name: "login_submit" },
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
        { replace: [{ pattern: "/api/*", target: { static: "events.html" } }] },
        "routes.replace.0.target",
        /target shorthand/,
      ],
      [
        { replace: [{ pattern: "/api/*", extra: true, target: { type: "function", name: "api" } }] },
        "routes.replace.0.extra",
        /Unknown ReleaseSpec field/,
      ],
      [
        { replace: [{ pattern: "/api/*", methods: ["GET", "GET"], target: { type: "function", name: "api" } }] },
        "routes.replace.0.methods",
        /duplicate method/,
      ],
      [
        { replace: [{ pattern: "/share", methods: ["GET"], target: { type: "function", name: "share" }, acknowledge_readonly: true }] },
        "routes.replace.0.acknowledge_readonly",
        /GET\/HEAD final-wildcard function routes/,
      ],
      [
        { replace: [{ pattern: "/share/*", methods: ["GET"], target: { type: "static", file: "share.html" }, acknowledge_readonly: true }] },
        "routes.replace.0.acknowledge_readonly",
        /GET\/HEAD final-wildcard function routes/,
      ],
      [
        { replace: [{ pattern: "/share/*", methods: ["GET", "POST"], target: { type: "function", name: "share" }, acknowledge_readonly: true }] },
        "routes.replace.0.acknowledge_readonly",
        /GET\/HEAD final-wildcard function routes/,
      ],
      [
        { replace: [{ pattern: "/share/*", methods: ["GET"], target: { type: "function", name: "share" }, acknowledge_readonly: false }] },
        "routes.replace.0.acknowledge_readonly",
        /must be true/,
      ],
      [
        { replace: [{ pattern: "/docs/*", methods: ["GET"], target: { type: "static", file: "docs/index.html" } }] },
        "routes.replace.0.pattern",
        /exact path pattern/,
      ],
      [
        { replace: [{ pattern: "/events", target: { type: "static", file: "events.html" } }] },
        "routes.replace.0.methods",
        /methods is required/,
      ],
      [
        { replace: [{ pattern: "/events", methods: ["POST"], target: { type: "static", file: "events.html" } }] },
        "routes.replace.0.methods",
        /static route targets must be/,
      ],
      [
        { replace: [{ pattern: "/events", methods: ["HEAD"], target: { type: "static", file: "events.html" } }] },
        "routes.replace.0.methods",
        /static route targets must be/,
      ],
      [
        { replace: [{ pattern: "/events", methods: ["GET"], target: { type: "static", file: "/events.html" } }] },
        "routes.replace.0.target.file",
        /relative materialized static-site file path/,
      ],
      [
        { replace: [{ pattern: "/events", methods: ["GET"], target: { type: "static", file: "page.html?slug=events" } }] },
        "routes.replace.0.target.file",
        /relative materialized static-site file path/,
      ],
      [
        { replace: [{ pattern: "/events", methods: ["GET"], target: { type: "static", file: "../events.html" } }] },
        "routes.replace.0.target.file",
        /relative materialized static-site file path/,
      ],
      [
        { replace: [{ pattern: "/events", methods: ["GET"], target: { type: "static", file: "a//b.html" } }] },
        "routes.replace.0.target.file",
        /relative materialized static-site file path/,
      ],
      [
        { replace: [{ pattern: "/events", methods: ["GET"], target: { type: "static", file: "a\\b.html" } }] },
        "routes.replace.0.target.file",
        /relative materialized static-site file path/,
      ],
      [
        { replace: [{ pattern: "/events", methods: ["GET"], target: { type: "static", file: "events/" } }] },
        "routes.replace.0.target.file",
        /relative materialized static-site file path/,
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

  it("resolves URL inputs with apikey auth and ignores query/fragment client-side", async () => {
    const w = makeWiring();
    w.setHandler((req) => {
      assert.equal(req.method, undefined);
      assert.equal(req.headers?.apikey, "ak");
      return {
        hostname: "example.com",
        result: 200,
        match: "static_exact",
        authorized: true,
        fallback_state: "not_used",
        static_sha256: "a".repeat(64),
        cache_class: "immutable_versioned",
        cache_policy: "public, max-age=31536000, immutable",
      } satisfies DeployResolveResponse;
    });

    const deploy = new Deploy(w.client);
    const result = await deploy.resolve({
      project: "prj_test",
      url: "https://Example.COM/assets/app.js?x=1#top",
      method: "get",
    });

    assert.equal(result.match, "static_exact");
    assert.equal(w.requests.length, 1);
    assert.equal(
      w.requests[0]!.path,
      "/deploy/v2/resolve?host=example.com&path=%2Fassets%2Fapp.js&method=GET",
    );
  });

  it("resolves host/path inputs with URLSearchParams encoding", async () => {
    const w = makeWiring();
    w.setHandler(() => ({
      hostname: "Example.COM",
      result: 404,
      match: "host_missing",
      authorized: false,
      fallback_state: "not_used",
    }) satisfies DeployResolveResponse);

    const deploy = new Deploy(w.client);
    const result = await deploy.resolve({
      project: "prj_test",
      host: "Example.COM",
      path: "/assets/a b.js",
      method: "HEAD",
    });

    assert.equal(result.match, "host_missing");
    assert.equal(
      w.requests[0]!.path,
      "/deploy/v2/resolve?host=Example.COM&path=%2Fassets%2Fa+b.js&method=HEAD",
    );
  });

  it("omits optional host/path path and method when callers omit them", async () => {
    const w = makeWiring();
    w.setHandler(() => ({
      hostname: "example.com",
      result: 404,
      match: "none",
      authorized: true,
      fallback_state: "not_used",
    }) satisfies DeployResolveResponse);

    const deploy = new Deploy(w.client);
    await deploy.resolve({ project: "prj_test", host: "example.com" });

    assert.equal(w.requests[0]!.path, "/deploy/v2/resolve?host=example.com");
  });

  it("rejects invalid resolve inputs before network calls", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    const badInputs: Array<[unknown, RegExp]> = [
      [{ project: "prj_test", url: "https://example.com/", host: "example.com" }, /exactly one input form/],
      [{ project: "prj_test", url: "/relative" }, /absolute HTTP\(S\)/],
      [{ project: "prj_test", url: "ftp://example.com/" }, /http: or https:/],
      [{ project: "prj_test", url: "https://user:pass@example.com/" }, /username or password/],
      [{ project: "prj_test", host: "https://example.com" }, /clean hostname/],
      [{ project: "prj_test", host: "example.com/path" }, /clean hostname/],
      [{ project: "prj_test", host: "example.com", path: "assets/app.js" }, /start with/],
      [{ project: "prj_test", host: "example.com", path: "/assets/app.js?x=1" }, /query strings or fragments/],
      [{ project: "prj_test", host: "example.com", method: "bad method" }, /valid HTTP token/],
    ];

    for (const [input, pattern] of badInputs) {
      await assert.rejects(
        () => deploy.resolve(input as never),
        (err: unknown) => {
          assert.match((err as Error).message, pattern);
          return true;
        },
      );
    }
    assert.equal(w.requests.length, 0);
  });

  it("preserves sparse host-miss and future route-aware fields", async () => {
    const w = makeWiring();
    w.setHandler((req) => {
      if (req.path.includes("missing.example")) {
        return {
          hostname: "missing.example",
          result: 404,
          match: "host_missing",
          authorized: false,
          fallback_state: "not_used",
        } satisfies DeployResolveResponse;
      }
      return {
        hostname: "example.com",
        result: 200,
        match: "route_static_alias",
        authorized: true,
        fallback_state: "not_used",
        route: {
          pattern: "/events",
          methods: ["GET", "HEAD"],
          target: { type: "static", file: "events.html" },
        },
        asset_path: "events.html",
        reachability_authority: "route_static_alias",
        direct: false,
        cache_class: "future_cache_class",
      } satisfies DeployResolveResponse;
    });

    const deploy = new Deploy(w.client);
    const miss = await deploy.resolve({ project: "prj_test", host: "missing.example" });
    const routed = await deploy.resolve({ project: "prj_test", host: "example.com", path: "/events" });

    assert.equal(miss.match, "host_missing");
    assert.equal(miss.release_id, undefined);
    assert.equal(routed.match, "route_static_alias");
    assert.deepEqual(routed.route?.target, { type: "static", file: "events.html" });
    assert.equal(routed.asset_path, "events.html");
    assert.equal(routed.reachability_authority, "route_static_alias");
    assert.equal(routed.direct, false);
    assert.equal(routed.cache_class, "future_cache_class");
  });

  it("preserves static CAS failures and summarizes them as non-serving", async () => {
    const w = makeWiring();
    w.setHandler(() => ({
      hostname: "example.com",
      project_id: "prj_test",
      release_id: "rel_123",
      release_generation: 7,
      result: 200,
      match: "static_exact",
      authorized: true,
      authorization_result: "missing_cas_object",
      fallback_state: "not_used",
      asset_path: "assets/app.js",
      static_sha256: "a".repeat(64),
      cas_object: {
        sha256: "a".repeat(64),
        exists: false,
        expected_size: 1234,
        actual_size: null,
      },
    }) satisfies DeployResolveResponse);

    const deploy = new Deploy(w.client);
    const input = { project: "prj_test", host: "example.com", path: "/assets/app.js" } as const;
    const result = await deploy.resolve(input);
    const summary = buildDeployResolveSummary(
      result,
      normalizeDeployResolveRequest(input),
    );

    assert.equal(result.authorization_result, "missing_cas_object");
    assert.deepEqual(result.cas_object, {
      sha256: "a".repeat(64),
      exists: false,
      expected_size: 1234,
      actual_size: null,
    });
    assert.equal(summary.would_serve, false);
    assert.equal(summary.category, "cas");
    assert.match(summary.summary, /backing CAS object is missing/);
    assert.equal(summary.next_steps[0]?.code, "redeploy_static_asset");
  });

  it("preserves hostname-specific HTML response variant diagnostics", async () => {
    const w = makeWiring();
    w.setHandler(() => ({
      hostname: "www.example.com",
      project_id: "prj_test",
      release_id: "rel_123",
      release_generation: 3,
      result: 200,
      match: "static_exact",
      authorized: true,
      authorization_result: "authorized",
      fallback_state: "not_used",
      asset_path: "index.html",
      static_sha256: "b".repeat(64),
      content_type: "text/html; charset=utf-8",
      cache_class: "html",
      response_variant: {
        kind: "html",
        varies_by: "hostname",
        hostname: "www.example.com",
        release_id: "rel_123",
        release_generation: 3,
        path: "/index.html",
        raw_static_sha256: "b".repeat(64),
        variant_inputs_hash: "c".repeat(64),
      },
    }) satisfies DeployResolveResponse);

    const deploy = new Deploy(w.client);
    const result = await deploy.resolve({
      project: "prj_test",
      host: "www.example.com",
      path: "/",
    });

    assert.equal(result.response_variant?.kind, "html");
    assert.equal(result.response_variant?.varies_by, "hostname");
    assert.equal(result.response_variant?.hostname, "www.example.com");
    assert.equal(result.response_variant?.release_generation, 3);
    assert.equal(result.response_variant?.variant_inputs_hash, "c".repeat(64));
  });

  it("preserves flattened route diagnostics and summarizes method misses", async () => {
    const w = makeWiring();
    w.setHandler(() => ({
      hostname: "example.com",
      result: 405,
      match: "route_method_miss",
      authorized: true,
      authorization_result: "not_applicable",
      fallback_state: "method_not_static",
      allow: ["GET", "HEAD"],
      route_pattern: "/events",
      target_type: "static",
      target_file: "events.html",
    }) satisfies DeployResolveResponse);

    const deploy = new Deploy(w.client);
    const input = {
      project: "prj_test",
      host: "example.com",
      path: "/events",
      method: "POST",
    } as const;
    const result = await deploy.resolve(input);
    const summary = buildDeployResolveSummary(
      result,
      normalizeDeployResolveRequest(input),
    );

    assert.equal(result.match, "route_method_miss");
    assert.deepEqual(result.allow, ["GET", "HEAD"]);
    assert.equal(result.route_pattern, "/events");
    assert.equal(result.target_type, "static");
    assert.equal(result.target_file, "events.html");
    assert.equal(summary.would_serve, false);
    assert.equal(summary.category, "route_method");
    assert.match(summary.summary, /Allowed methods: GET, HEAD/);
    assert.equal(summary.next_steps[0]?.code, "check_route_methods");
  });

  it("treats unsupported static manifests as known non-serving diagnostics", async () => {
    const response = {
      hostname: "example.com",
      result: 503,
      match: "unsupported_manifest_version",
      authorized: false,
      authorization_result: "unsupported_manifest_version",
      fallback_state: "unsupported_manifest_version",
      static_manifest_sha256: "d".repeat(64),
    } satisfies DeployResolveResponse;
    const summary = buildDeployResolveSummary(
      response,
      normalizeDeployResolveRequest({ project: "prj_test", host: "example.com" }),
    );

    assert.equal(summary.would_serve, false);
    assert.equal(summary.category, "manifest");
    assert.match(summary.summary, /static manifest version is not supported/);
    assert.equal(summary.next_steps[0]?.code, "redeploy_static_site");

    const cachedMiss = {
      hostname: "example.com",
      result: 404,
      match: "none",
      authorized: false,
      fallback_state: "negative_cache_hit",
    } satisfies DeployResolveResponse;
    assert.equal(cachedMiss.fallback_state, "negative_cache_hit");
  });

  it("keeps unknown resolve matches on generic inspect guidance", () => {
    const response = {
      hostname: "example.com",
      result: 599,
      match: "future_gateway_match",
      authorized: true,
      fallback_state: "future_fallback",
    } satisfies DeployResolveResponse;
    const summary = buildDeployResolveSummary(
      response,
      normalizeDeployResolveRequest({ project: "prj_test", host: "example.com" }),
    );

    assert.equal(summary.would_serve, false);
    assert.equal(summary.category, "unknown");
    assert.equal(summary.next_steps[0]?.code, "inspect_resolution");
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
  it("aborts before commit on client-detected wildcard route method warnings", async () => {
    const w = makeWiring();
    const events: DeployEvent[] = [];
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") return noContentPlan("plan_route_lint", "op_route_lint");
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    await assert.rejects(
      () =>
        deploy.apply(
          {
            project: "prj_test",
            routes: {
              replace: [
                {
                  pattern: "/admin/*",
                  methods: ["GET"],
                  target: { type: "function", name: "admin" },
                },
              ],
            },
          },
          { onEvent: (event) => events.push(event) },
        ),
      (err: unknown) => {
        assert(err instanceof Run402DeployError);
        assert.equal(err.code, "WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS");
        assert.equal(err.phase, "plan");
        assert.deepEqual((err.body as { warnings: Array<{ affected?: string[] }> }).warnings[0]?.affected, ["/admin/*"]);
        return true;
      },
    );

    assert.deepEqual(w.requests.map((r) => r.path), ["/deploy/v2/plans"]);
    const warningEvent = events.find((event) => event.type === "plan.warnings");
    assert.ok(warningEvent && warningEvent.type === "plan.warnings");
    assert.equal(warningEvent.warnings[0]?.code, "WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS");
  });

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
        assert.deepEqual(err.body, {
          warnings: plan.warnings,
          unacknowledged_warnings: plan.warnings,
          unacknowledged_warning_codes: ["MISSING_REQUIRED_SECRET"],
          allowed_warning_codes: [],
        });
        return true;
      },
    );
    assert.deepEqual(w.requests.map((r) => r.path), ["/deploy/v2/plans"]);
    assert.equal(events.some((event) => event.type === "plan.warnings"), true);
  });

  it("continues when every blocking warning code is explicitly allowed", async () => {
    const w = makeWiring();
    const warnings = [
      {
        code: "WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS",
        severity: "medium" as const,
        requires_confirmation: true,
        message: "Read-only wildcard",
        affected: ["/share/*"],
      },
    ];
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") {
        return {
          plan_id: "plan_warning_code_ok",
          operation_id: "op_warning_code_ok",
          base_release_id: null,
          manifest_digest: "warning-code-ok",
          missing_content: [],
          diff: {},
          warnings,
        } satisfies PlanResponse;
      }
      if (req.path === "/deploy/v2/plans/plan_warning_code_ok/commit") {
        return {
          operation_id: "op_warning_code_ok",
          status: "ready",
          release_id: "rel_warning_code_ok",
          urls: {},
        } satisfies CommitResponse;
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    const result = await deploy.apply(
      {
        project: "prj_test",
        routes: { replace: [] },
      },
      { allowWarningCodes: ["WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS"] },
    );

    assert.equal(result.release_id, "rel_warning_code_ok");
    assert.deepEqual(result.warnings, warnings);
  });

  it("blocks warning codes that were not explicitly allowed", async () => {
    const w = makeWiring();
    const warnings = [
      {
        code: "WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS",
        severity: "medium" as const,
        requires_confirmation: true,
        message: "Read-only wildcard",
        affected: ["/share/*"],
      },
      {
        code: "MISSING_REQUIRED_SECRET",
        severity: "high" as const,
        requires_confirmation: true,
        message: "OPENAI_API_KEY is missing",
        affected: ["OPENAI_API_KEY"],
      },
    ];
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") {
        return {
          plan_id: "plan_warning_code_block",
          operation_id: "op_warning_code_block",
          base_release_id: null,
          manifest_digest: "warning-code-block",
          missing_content: [],
          diff: {},
          warnings,
        } satisfies PlanResponse;
      }
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
          { allowWarningCodes: ["WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS"] },
        ),
      (err: unknown) => {
        assert(err instanceof Run402DeployError);
        assert.equal(err.code, "MISSING_REQUIRED_SECRET");
        assert.deepEqual((err.body as { unacknowledged_warning_codes?: string[] }).unacknowledged_warning_codes, [
          "MISSING_REQUIRED_SECRET",
        ]);
        assert.deepEqual((err.body as { allowed_warning_codes?: string[] }).allowed_warning_codes, [
          "WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS",
        ]);
        return true;
      },
    );

    assert.deepEqual(w.requests.map((r) => r.path), ["/deploy/v2/plans"]);
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

describe("Deploy.status", () => {
  it("throws Run402DeployError without issuing any request when operationId is empty", async () => {
    const w = makeWiring();
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.status("", { project: "prj_test" }),
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
      () => deploy.status("notop_xx", { project: "prj_test" }),
      (err: unknown) =>
        err instanceof Run402DeployError &&
        (err as Run402DeployError).code === "OPERATION_NOT_FOUND" &&
        (err as Run402DeployError).retryable === false,
    );
    assert.equal(w.requests.length, 0, "no HTTP request issued for invalid prefix");
  });

  it("encodes operation id path component", async () => {
    const w = makeWiring();
    const ready: OperationSnapshot = {
      operation_id: "op_slash/test",
      plan_id: "plan_1",
      status: "ready",
      phase: "ready",
    } as OperationSnapshot;
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/operations/op_slash%2Ftest") return ready;
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    assert.deepEqual(await deploy.status("op_slash/test", { project: "prj_test" }), ready);
  });

  it("translates a gateway 404 with {code:'operation_not_found'} into a Run402DeployError", async () => {
    const w = makeWiring();
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/operations/op_does_not_exist") {
        throw new ApiError(
          "API error while fetching deploy operation (HTTP 404)",
          404,
          { code: "operation_not_found", message: "operation not found" },
          "fetching deploy operation",
        );
      }
      throw new Error(`unexpected ${req.path}`);
    });
    const deploy = new Deploy(w.client);
    await assert.rejects(
      () => deploy.status("op_does_not_exist", { project: "prj_test" }),
      (err: unknown) =>
        err instanceof Run402DeployError &&
        (err as Run402DeployError).code === "OPERATION_NOT_FOUND",
    );
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

describe("Deploy.apply (activation_pending classification)", () => {
  it("throws immediately for static activation failures and preserves gateway metadata", async () => {
    const w = makeWiring();
    let operationPolls = 0;
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") {
        return noContentPlan("plan_static", "op_static");
      }
      if (req.path === "/deploy/v2/plans/plan_static/commit") {
        return {
          operation_id: "op_static",
          status: "activation_pending",
        } satisfies CommitResponse;
      }
      if (req.path === "/deploy/v2/operations/op_static") {
        operationPolls += 1;
        return {
          operation_id: "op_static",
          project_id: "prj_test",
          plan_id: "plan_static",
          status: "activation_pending",
          base_release_id: null,
          target_release_id: "rel_static",
          release_id: null,
          urls: null,
          payment_required: null,
          error: {
            code: "FUNCTION_ACTIVATE_FAILED",
            phase: "activate",
            resource: "functions.api",
            message: "Function config is not eligible for this tier.",
            retryable: true,
            safe_to_retry: false,
            operation_id: "op_static",
            plan_id: "plan_static",
            details: {
              field: "functions.api.config.timeoutSeconds",
              tier: "prototype",
              tier_max: 10,
            },
          },
          activate_attempts: 1,
          last_activate_attempt_at: "2026-05-16T12:00:00.000Z",
          created_at: "2026-05-16T12:00:00.000Z",
          updated_at: "2026-05-16T12:00:01.000Z",
        } satisfies OperationSnapshot;
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    await assert.rejects(
      () =>
        deploy.apply({
          project: "prj_test",
          site: { replace: { "index.html": "ok" } },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Run402DeployError);
        const e = err as Run402DeployError;
        assert.equal(e.code, "FUNCTION_ACTIVATE_FAILED");
        assert.equal(e.phase, "activate");
        assert.equal(e.resource, "functions.api");
        assert.equal(e.retryable, true);
        assert.equal(e.safeToRetry, false);
        assert.equal(e.operationId, "op_static");
        assert.equal(e.planId, "plan_static");
        assert.deepEqual(e.details, {
          field: "functions.api.config.timeoutSeconds",
          tier: "prototype",
          tier_max: 10,
        });
        return true;
      },
    );

    assert.equal(operationPolls, 1, "static activation failures should not wait for another poll");
  });

  it("continues polling activation_pending snapshots without terminal error metadata", async () => {
    const w = makeWiring();
    let operationPolls = 0;
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") {
        return noContentPlan("plan_recoverable", "op_recoverable");
      }
      if (req.path === "/deploy/v2/plans/plan_recoverable/commit") {
        return {
          operation_id: "op_recoverable",
          status: "activation_pending",
        } satisfies CommitResponse;
      }
      if (req.path === "/deploy/v2/operations/op_recoverable") {
        operationPolls += 1;
        return {
          operation_id: "op_recoverable",
          project_id: "prj_test",
          plan_id: "plan_recoverable",
          status: operationPolls === 1 ? "activation_pending" : "ready",
          base_release_id: null,
          target_release_id: "rel_recoverable",
          release_id: operationPolls === 1 ? null : "rel_recoverable",
          urls: operationPolls === 1 ? null : { site: "https://rel.run402.test" },
          payment_required: null,
          error: null,
          activate_attempts: operationPolls,
          last_activate_attempt_at: "2026-05-16T12:00:00.000Z",
          created_at: "2026-05-16T12:00:00.000Z",
          updated_at: "2026-05-16T12:00:01.000Z",
        } satisfies OperationSnapshot;
      }
      throw new Error(`unexpected ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    const result = await deploy.apply({
      project: "prj_test",
      site: { replace: { "index.html": "ok" } },
    });

    assert.equal(result.release_id, "rel_recoverable");
    assert.equal(operationPolls, 2, "recoverable activation_pending should keep polling");
  });
});

describe("Deploy.apply (safe race retry)", () => {
  it("does not safe-race retry static activation failures", async () => {
    const w = makeWiring();
    const events: DeployEvent[] = [];
    let planCalls = 0;
    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") {
        planCalls += 1;
        return noContentPlan("plan_static_no_retry", "op_static_no_retry");
      }
      if (req.path === "/deploy/v2/plans/plan_static_no_retry/commit") {
        return {
          operation_id: "op_static_no_retry",
          status: "activation_pending",
        } satisfies CommitResponse;
      }
      if (req.path === "/deploy/v2/operations/op_static_no_retry") {
        return {
          operation_id: "op_static_no_retry",
          project_id: "prj_test",
          plan_id: "plan_static_no_retry",
          status: "activation_pending",
          base_release_id: null,
          target_release_id: "rel_static_no_retry",
          release_id: null,
          urls: null,
          payment_required: null,
          error: {
            code: "FUNCTION_ACTIVATE_FAILED",
            message: "Function config is not eligible for this tier.",
            phase: "activate",
            resource: "functions.worker",
            retryable: true,
            safe_to_retry: false,
          },
          activate_attempts: 1,
          last_activate_attempt_at: "2026-05-16T12:00:00.000Z",
          created_at: "2026-05-16T12:00:00.000Z",
          updated_at: "2026-05-16T12:00:01.000Z",
        } satisfies OperationSnapshot;
      }
      throw new Error(`unexpected path ${req.path}`);
    });

    const deploy = new Deploy(w.client);
    await assert.rejects(
      () =>
        deploy.apply(
          { project: "prj_test", site: { replace: { "index.html": "ok" } } },
          { onEvent: (event) => events.push(event) },
        ),
      (err: unknown) => err instanceof Run402DeployError &&
        (err as Run402DeployError).code === "FUNCTION_ACTIVATE_FAILED",
    );

    assert.equal(planCalls, 1);
    assert.equal(events.some((event) => event.type === "deploy.retry"), false);
  });

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
      has_more: false,
      next_cursor: null,
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
    assert.equal(result.next_cursor, null);
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

  it("forwards cursor as before for pagination back-compat", async () => {
    const w = makeWiring();
    w.setHandler(() => ({ operations: [], cursor: null }));
    const deploy = new Deploy(w.client);
    await deploy.list({ project: "prj_test", cursor: "op_cursor" });
    assert.equal(w.requests[0].path, "/deploy/v2/operations?before=op_cursor");
  });

  it("forwards limit and before as query strings", async () => {
    const w = makeWiring();
    w.setHandler(() => ({ operations: [], next_cursor: null }));
    const deploy = new Deploy(w.client);
    await deploy.list({ project: "prj_test", limit: 5, before: "op_cursor" });
    assert.equal(w.requests[0].path, "/deploy/v2/operations?limit=5&before=op_cursor");
  });

  it("forwards operation filters and include_total", async () => {
    const w = makeWiring();
    w.setHandler(() => ({ operations: [], has_more: false, next_cursor: null, total: 0 }));
    const deploy = new Deploy(w.client);
    await deploy.list({
      project: "prj_test",
      status: "ready",
      since: "2026-05-16T00:00:00Z",
      project_id: "prj_filter",
      includeTotal: true,
    });
    assert.equal(
      w.requests[0].path,
      "/deploy/v2/operations?status=ready&since=2026-05-16T00%3A00%3A00Z&project_id=prj_filter&include_total=true",
    );
  });

  it("rejects invalid limit values with a LocalError before issuing a request", async () => {
    const invalidLimits = [
      { label: "NaN", value: Number.NaN },
      { label: "zero", value: 0 },
      { label: "negative", value: -1 },
      { label: "fractional", value: 1.5 },
      { label: "infinite", value: Number.POSITIVE_INFINITY },
      { label: "unsafe", value: Number.MAX_SAFE_INTEGER + 1 },
    ];

    for (const { label, value } of invalidLimits) {
      const w = makeWiring();
      const deploy = new Deploy(w.client);
      await assert.rejects(
        () => deploy.list({ project: "prj_test", limit: value }),
        (err: unknown) =>
          err instanceof LocalError && /limit/i.test((err as LocalError).message),
        `${label} limit should be rejected locally`,
      );
      assert.equal(w.requests.length, 0, `${label}: no gateway request`);
    }
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
    static_public_paths: [
      {
        public_path: "/events",
        asset_path: "events.html",
        reachability_authority: "explicit_public_path",
        direct: true,
        cache_class: "html",
        content_type: "text/html",
      },
    ],
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
    assert.equal(result.static_public_paths?.[0]?.public_path, "/events");
    assert.equal(result.static_public_paths?.[0]?.asset_path, "events.html");
    assert.equal(result.static_public_paths?.[0]?.direct, true);
    assert.equal(w.requests[0].headers?.apikey, "ak");
  });

  it("rejects invalid getRelease siteLimit values before issuing a request", async () => {
    const invalidLimits = [
      { label: "NaN", value: Number.NaN },
      { label: "zero", value: 0 },
      { label: "negative", value: -1 },
      { label: "fractional", value: 1.5 },
      { label: "infinite", value: Number.POSITIVE_INFINITY },
      { label: "unsafe", value: Number.MAX_SAFE_INTEGER + 1 },
    ];

    for (const { label, value } of invalidLimits) {
      const w = makeWiring();
      const deploy = new Deploy(w.client);
      await assert.rejects(
        () =>
          deploy.getRelease({
            project: "prj_test",
            releaseId: "rel_1",
            siteLimit: value,
          }),
        (err: unknown) =>
          err instanceof LocalError && /siteLimit/i.test((err as LocalError).message),
        `${label} siteLimit should be rejected locally`,
      );
      assert.equal(w.requests.length, 0, `${label}: no gateway request`);
    }
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

  it("rejects invalid getActiveRelease siteLimit values before issuing a request", async () => {
    const invalidLimits = [
      { label: "NaN", value: Number.NaN },
      { label: "zero", value: 0 },
      { label: "negative", value: -1 },
      { label: "fractional", value: 1.5 },
      { label: "infinite", value: Number.POSITIVE_INFINITY },
      { label: "unsafe", value: Number.MAX_SAFE_INTEGER + 1 },
    ];

    for (const { label, value } of invalidLimits) {
      const w = makeWiring();
      const deploy = new Deploy(w.client);
      await assert.rejects(
        () => deploy.getActiveRelease({ project: "prj_test", siteLimit: value }),
        (err: unknown) =>
          err instanceof LocalError && /siteLimit/i.test((err as LocalError).message),
        `${label} siteLimit should be rejected locally`,
      );
      assert.equal(w.requests.length, 0, `${label}: no gateway request`);
    }
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

  it("rejects invalid diff limit values before issuing a request", async () => {
    const invalidLimits = [
      { label: "NaN", value: Number.NaN },
      { label: "zero", value: 0 },
      { label: "negative", value: -1 },
      { label: "fractional", value: 1.5 },
      { label: "infinite", value: Number.POSITIVE_INFINITY },
      { label: "unsafe", value: Number.MAX_SAFE_INTEGER + 1 },
    ];

    for (const { label, value } of invalidLimits) {
      const w = makeWiring();
      const deploy = new Deploy(w.client);
      await assert.rejects(
        () =>
          deploy.diff({
            project: "prj_test",
            from: "empty",
            to: "rel_2",
            limit: value,
          }),
        (err: unknown) =>
          err instanceof LocalError && /limit/i.test((err as LocalError).message),
        `${label} limit should be rejected locally`,
      );
      assert.equal(w.requests.length, 0, `${label}: no gateway request`);
    }
  });

  it("rejects missing or empty diff selectors before issuing a request", async () => {
    const cases: Array<{
      label: string;
      opts: Parameters<Deploy["diff"]>[0];
      expectedMessage: RegExp;
    }> = [
      {
        label: "missing from",
        opts: { project: "prj_test", to: "rel_2" } as unknown as Parameters<
          Deploy["diff"]
        >[0],
        expectedMessage: /from/i,
      },
      {
        label: "missing to",
        opts: { project: "prj_test", from: "rel_1" } as unknown as Parameters<
          Deploy["diff"]
        >[0],
        expectedMessage: /to/i,
      },
      {
        label: "empty from",
        opts: { project: "prj_test", from: "", to: "rel_2" },
        expectedMessage: /from/i,
      },
      {
        label: "empty to",
        opts: { project: "prj_test", from: "rel_1", to: "" },
        expectedMessage: /to/i,
      },
    ];

    for (const { label, opts, expectedMessage } of cases) {
      const w = makeWiring();
      const deploy = new Deploy(w.client);
      await assert.rejects(
        () => deploy.diff(opts),
        (err: unknown) =>
          err instanceof LocalError && expectedMessage.test((err as LocalError).message),
        `${label} should be rejected locally`,
      );
      assert.equal(w.requests.length, 0, `${label}: no gateway request`);
    }
  });

});
