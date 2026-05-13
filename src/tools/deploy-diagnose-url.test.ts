import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

let lastResolveInput: unknown = null;
let nextResolveImpl: (opts: unknown) => Promise<unknown> = async () => ({
  hostname: "example.com",
  result: 200,
  match: "static_exact",
  authorized: true,
  fallback_state: "not_used",
});

mock.module("../sdk.js", {
  namedExports: {
    getSdk: () => ({
      deploy: {
        resolve: async (opts: unknown) => {
          lastResolveInput = opts;
          return nextResolveImpl(opts);
        },
      },
    }),
    _resetSdk: () => {},
  },
});

const { handleDeployDiagnoseUrl } = await import("./deploy-diagnose-url.js");

beforeEach(() => {
  lastResolveInput = null;
  nextResolveImpl = async () => ({
    hostname: "example.com",
    result: 200,
    match: "static_exact",
    authorized: true,
    fallback_state: "not_used",
  });
});

describe("deploy_diagnose_url", () => {
  it("calls SDK deploy.resolve with URL input and renders structured output", async () => {
    nextResolveImpl = async () => ({
      hostname: "example.com",
      result: 404,
      match: "host_missing",
      authorized: false,
      fallback_state: "not_used",
    });

    const result = await handleDeployDiagnoseUrl({
      project_id: "prj_test",
      url: "https://example.com/?utm=x#hero",
      method: "GET",
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(lastResolveInput, {
      project: "prj_test",
      url: "https://example.com/?utm=x#hero",
      method: "GET",
    });
    assert.match(result.content[0]!.text, /would_serve \| false/);
    assert.match(result.content[0]!.text, /host_missing/);
    assert.match(result.content[0]!.text, /query_ignored/);
    assert.match(result.content[0]!.text, /fragment_ignored/);
    const raw = result.content[1]!.text;
    assert.match(raw, /"request"/);
    assert.match(raw, /"resolution"/);
    assert.match(raw, /"next_steps"/);
  });

  it("supports host/path input and preserves future route-aware fields", async () => {
    nextResolveImpl = async () => ({
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
      static_manifest_metadata: {
        file_count: 1,
        total_bytes: 12,
        cache_classes: { html: 1 },
        cache_class_sources: { inferred: 1 },
        spa_fallback: null,
      },
    });

    const result = await handleDeployDiagnoseUrl({
      project_id: "prj_test",
      host: "example.com",
      path: "/events",
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(lastResolveInput, {
      project: "prj_test",
      host: "example.com",
      path: "/events",
    });
    assert.match(result.content[1]!.text, /route_static_alias/);
    assert.match(result.content[1]!.text, /"asset_path": "events.html"/);
    assert.match(result.content[1]!.text, /"direct": false/);
    assert.match(result.content[1]!.text, /"file": "events.html"/);
    assert.match(result.content[1]!.text, /static_manifest_metadata/);
  });

  it("rejects URL and host/path conflicts before SDK calls", async () => {
    const result = await handleDeployDiagnoseUrl({
      project_id: "prj_test",
      url: "https://example.com/",
      host: "example.com",
    });

    assert.equal(result.isError, true);
    assert.equal(lastResolveInput, null);
    assert.match(result.content[0]!.text, /exactly one input form/);
  });

  it("maps SDK errors through shared error formatting", async () => {
    nextResolveImpl = async () => {
      const { ApiError } = await import("../../sdk/dist/index.js");
      throw new ApiError("Bad host while diagnosing deploy URL", 400, {
        code: "BAD_HOST",
        message: "Invalid host.",
      }, "diagnosing deploy URL");
    };

    const result = await handleDeployDiagnoseUrl({
      project_id: "prj_test",
      host: "bad_host",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /Invalid host/);
    assert.match(result.content[0]!.text, /Code: `BAD_HOST`/);
  });
});
