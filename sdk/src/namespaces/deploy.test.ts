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
