/**
 * Unit tests for the `apps` namespace's `bundleDeploy` compatibility shim.
 *
 * Drives `apps.bundleDeploy` against a fake `Client` that handles the
 * underlying `r.deploy.apply` wire sequence. The focus here is the legacy
 * input-shape translation in `translateBundleToReleaseSpec` — particularly
 * the `rls` field validation path, which previously crashed with TypeError
 * when a caller passed a string instead of `{ template, tables[] }` (#125).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Apps } from "./apps.js";
import type { Client, RequestOptions } from "../kernel.js";
import type { CommitResponse, PlanResponse } from "./deploy.types.js";
import { Run402DeployError } from "../errors.js";

interface RecordedRequest {
  path: string;
  method?: string;
  body?: unknown;
}

interface FakeWiring {
  client: Client;
  requests: RecordedRequest[];
  setHandler(fn: (req: RecordedRequest) => unknown): void;
}

function makeWiring(): FakeWiring {
  const requests: RecordedRequest[] = [];
  let handler: (req: RecordedRequest) => unknown = () => {
    throw new Error("no handler set");
  };

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
    fetch: (async () => new Response("", { status: 200 })) as typeof globalThis.fetch,
  };

  return {
    client,
    requests,
    setHandler(fn) {
      handler = fn;
    },
  };
}

describe("Apps.bundleDeploy (rls validation)", () => {
  it("rejects rls as a string with Run402DeployError code=INVALID_SPEC (not a TypeError)", async () => {
    const w = makeWiring();
    const apps = new Apps(w.client);
    await assert.rejects(
      // Cast through unknown — we are deliberately passing the wrong shape to
      // exercise the runtime guard that protects against legacy callers.
      () =>
        apps.bundleDeploy("prj_xxx", {
          rls: "default" as unknown as never,
          inherit: true,
        }),
      (err: unknown) => {
        assert(
          err instanceof Run402DeployError,
          `expected Run402DeployError, got ${(err as Error)?.constructor?.name}: ${(err as Error)?.message}`,
        );
        assert.equal((err as Run402DeployError).code, "INVALID_SPEC");
        assert.equal((err as Run402DeployError).resource, "rls");
        assert.equal((err as Run402DeployError).phase, "validate");
        assert.equal((err as Run402DeployError).retryable, false);
        assert(!(err instanceof TypeError), "must not leak the underlying TypeError");
        return true;
      },
    );
  });

  it("rejects rls as null with Run402DeployError code=INVALID_SPEC", async () => {
    const w = makeWiring();
    const apps = new Apps(w.client);
    await assert.rejects(
      () =>
        apps.bundleDeploy("prj_xxx", {
          rls: null as unknown as never,
        }),
      (err: unknown) =>
        err instanceof Run402DeployError &&
        (err as Run402DeployError).code === "INVALID_SPEC",
    );
  });

  it("rejects rls when tables is missing with Run402DeployError code=INVALID_SPEC", async () => {
    const w = makeWiring();
    const apps = new Apps(w.client);
    await assert.rejects(
      () =>
        apps.bundleDeploy("prj_xxx", {
          // template present but tables missing — common shape mistake.
          rls: { template: "user_owns_rows" } as unknown as never,
        }),
      (err: unknown) =>
        err instanceof Run402DeployError &&
        (err as Run402DeployError).code === "INVALID_SPEC",
    );
  });

  it("accepts a valid rls object with template+tables (happy path)", async () => {
    const w = makeWiring();

    const plan: PlanResponse = {
      plan_id: "plan_rls",
      operation_id: "op_rls",
      base_release_id: null,
      manifest_digest: "deadbeef",
      missing_content: [],
      diff: {},
    };
    const commit: CommitResponse = {
      operation_id: "op_rls",
      status: "ready",
      release_id: "rel_rls",
      urls: {},
    };

    w.setHandler((req) => {
      if (req.path === "/deploy/v2/plans") return plan;
      if (req.path === "/deploy/v2/plans/plan_rls/commit") return commit;
      throw new Error(`unexpected path ${req.path}`);
    });

    const apps = new Apps(w.client);
    const result = await apps.bundleDeploy("prj_xxx", {
      rls: {
        template: "user_owns_rows",
        tables: [{ table: "todos", owner_column: "user_id" }],
      },
    });

    assert.equal(result.project_id, "prj_xxx");

    // Confirm the rls translation wrote an `expose` manifest into the spec.
    const planReq = w.requests.find((r) => r.path === "/deploy/v2/plans");
    assert(planReq, "plan request was issued");
    const planBody = planReq.body as {
      spec: {
        database?: { expose?: { tables?: Array<{ name: string; policy: string }> } };
      };
    };
    const exposeTables = planBody.spec.database?.expose?.tables;
    assert(Array.isArray(exposeTables), "expose.tables exists in the plan spec");
    assert.equal(exposeTables.length, 1);
    assert.equal(exposeTables[0].name, "todos");
    assert.equal(exposeTables[0].policy, "user_owns_rows");
  });
});
