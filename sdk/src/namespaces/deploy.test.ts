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
import type { Client, RequestOptions } from "../kernel.js";
import type {
  CommitResponse,
  OperationSnapshot,
  PlanResponse,
} from "./deploy.types.js";
import { ApiError, NetworkError, Run402DeployError } from "../errors.js";
import { fileSetFromDir } from "../node/files.js";

interface RecordedRequest {
  path: string;
  method?: string;
  body?: unknown;
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

function makeWiring(): FakeWiring {
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
      const recorded: RecordedRequest = { path, method: opts.method, body: opts.body };
      requests.push(recorded);
      return handler(recorded) as T;
    },
    getProject: async () => ({ anon_key: "ak", service_key: "sk" }),
    credentials: {
      getAuth: async () => null,
      getProject: async () => ({ anon_key: "ak", service_key: "sk" }),
    },
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
    const contentBody = contentReq.body as { content: Array<{ sha256: string; size: number }> };
    assert.equal(contentBody.content[0].sha256, indexSha);
    assert.equal(contentBody.content[0].size, html.length);

    // S3 PUT received the correct bytes + checksum.
    assert.equal(w.puts.length, 1, "one S3 PUT for the missing file");
    assert.equal(w.puts[0].url, "https://s3.example/upload?part=1");
    assert.equal(w.puts[0].checksum, shaBase64Hex(indexSha));
    assert.equal(new TextDecoder().decode(w.puts[0].body), html);
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
