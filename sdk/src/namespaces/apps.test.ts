import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Apps, type AppSummary } from "./apps.js";
import type { Client, RequestOptions } from "../kernel.js";

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

describe("Apps.browse (AppSummary runtime shape)", () => {
  it("returns AppSummary objects with the full server-side shape populated", async () => {
    const w = makeWiring();

    const runtimeApp = {
      id: "ver_abc123",
      project_id: "prj_pub",
      version: 4,
      name: "Todo Demo",
      description: "A demo todo app",
      visibility: "public" as const,
      fork_allowed: true,
      fork_pricing: { prototype: "0", hobby: "1.50" },
      min_tier: "prototype" as const,
      derived_min_tier: "hobby" as const,
      status: "published" as const,
      table_count: 2,
      function_count: 1,
      site_file_count: 12,
      site_total_bytes: 4096,
      required_secrets: [{ key: "SENDGRID_KEY", description: "outbound email" }],
      required_actions: [{ action: "domain.verify", description: "DNS TXT record" }],
      tags: ["todo", "auth"],
      live_url: "https://demo.run402.app",
      bootstrap_variables: [{ name: "OWNER_EMAIL", required: true }],
      created_at: "2026-04-30T12:00:00Z",
      compatibility_warnings: ["uses node22 only"],
    };

    w.setHandler((req) => {
      if (req.path === "/apps/v1") return { apps: [runtimeApp], total: 1 };
      throw new Error(`unexpected path ${req.path}`);
    });

    const apps = new Apps(w.client);
    const result = await apps.browse();

    assert.equal(result.total, 1);
    assert.equal(result.apps.length, 1);

    const app: AppSummary = result.apps[0]!;
    assert.equal(app.id, "ver_abc123");
    assert.equal(app.project_id, "prj_pub");
    assert.equal(app.version, 4);
    assert.equal(app.name, "Todo Demo");
    assert.equal(app.description, "A demo todo app");
    assert.equal(app.visibility, "public");
    assert.equal(app.fork_allowed, true);
    assert.deepEqual(app.fork_pricing, { prototype: "0", hobby: "1.50" });
    assert.equal(app.min_tier, "prototype");
    assert.equal(app.derived_min_tier, "hobby");
    assert.equal(app.status, "published");
    assert.equal(app.table_count, 2);
    assert.equal(app.function_count, 1);
    assert.equal(app.site_file_count, 12);
    assert.equal(app.site_total_bytes, 4096);
    assert.deepEqual(app.required_secrets, [
      { key: "SENDGRID_KEY", description: "outbound email" },
    ]);
    assert.deepEqual(app.required_actions, [
      { action: "domain.verify", description: "DNS TXT record" },
    ]);
    assert.deepEqual(app.tags, ["todo", "auth"]);
    assert.equal(app.live_url, "https://demo.run402.app");
    assert.deepEqual(app.bootstrap_variables, [{ name: "OWNER_EMAIL", required: true }]);
    assert.equal(app.created_at, "2026-04-30T12:00:00Z");
    assert.deepEqual(app.compatibility_warnings, ["uses node22 only"]);
  });
});
