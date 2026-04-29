/**
 * Unit tests for `NodeSites.deployDir` — the Node-only directory deploy
 * convenience that wraps `r.deploy.apply`.
 *
 * Drives the v2 deploy primitive against a fake `Client` so we can assert the
 * shape of the legacy {@link SiteDeployResult} produced from a v2 commit
 * response. Specifically: the v2 commit returns
 * `urls = { project, release }` (no `urls.site` key), and the legacy
 * `result.url` field must be populated from `urls.project` so the downstream
 * UX (clipboard buttons, status pages, CLI prints) does not get an empty
 * string. See bug GH-130.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeSites } from "./sites-node.js";
import type { Client, RequestOptions } from "../kernel.js";
import type { CommitResponse, PlanResponse } from "../namespaces/deploy.types.js";

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
    fetch: (async () =>
      new Response("", { status: 200 })) as typeof globalThis.fetch,
  };

  return {
    client,
    requests,
    setHandler(fn) {
      handler = fn;
    },
  };
}

describe("NodeSites.deployDir result.url (GH-130)", () => {
  it("populates url from urls.project (the canonical v2 key)", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-sites-node-test-"));
    try {
      writeFileSync(join(root, "index.html"), "<h1>hi</h1>");

      const w = makeWiring();
      const projectUrl = "https://prj_xxx.run402.com";
      const plan: PlanResponse = {
        plan_id: "plan_legacy",
        operation_id: "op_legacy",
        base_release_id: null,
        manifest_digest: "abcd",
        // Empty missing_content keeps the deploy on the no-upload path so the
        // test stays focused on result-shape behaviour.
        missing_content: [],
        diff: {},
      };
      const commit: CommitResponse = {
        operation_id: "op_legacy",
        status: "ready",
        release_id: "rel_legacy",
        // v2 returns `project` + `release` — there is NO `site` key.
        urls: { project: projectUrl, release: "https://rel_legacy.run402.com" },
      };
      w.setHandler((req) => {
        if (req.path === "/deploy/v2/plans") return plan;
        if (req.path === "/deploy/v2/plans/plan_legacy/commit") return commit;
        throw new Error(`unexpected path ${req.path}`);
      });

      const sites = new NodeSites(w.client);
      const result = await sites.deployDir({
        project: "prj_xxx",
        dir: root,
      });

      assert.equal(result.deployment_id, "rel_legacy");
      assert.equal(
        result.url,
        projectUrl,
        "deployDir result.url must come from urls.project, not the empty-string fallback",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to urls.site when urls.project is absent (forward compat)", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-sites-node-test-"));
    try {
      writeFileSync(join(root, "index.html"), "<h1>hi</h1>");

      const w = makeWiring();
      const siteUrl = "https://legacy.run402.com";
      const plan: PlanResponse = {
        plan_id: "plan_site_only",
        operation_id: "op_site_only",
        base_release_id: null,
        manifest_digest: "abcd",
        missing_content: [],
        diff: {},
      };
      const commit: CommitResponse = {
        operation_id: "op_site_only",
        status: "ready",
        release_id: "rel_site_only",
        urls: { site: siteUrl },
      };
      w.setHandler((req) => {
        if (req.path === "/deploy/v2/plans") return plan;
        if (req.path === "/deploy/v2/plans/plan_site_only/commit") return commit;
        throw new Error(`unexpected path ${req.path}`);
      });

      const sites = new NodeSites(w.client);
      const result = await sites.deployDir({
        project: "prj_xxx",
        dir: root,
      });

      assert.equal(result.url, siteUrl);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
