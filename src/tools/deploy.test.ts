/**
 * Tests for the unified `deploy` MCP tool (src/tools/deploy.ts).
 *
 * These tests focus on the MCP-layer translation from the agent-facing
 * Zod-validated args into the SDK's `ReleaseSpec`. The SDK's `deploy.apply`
 * is mocked so we can capture the spec the MCP layer constructs and assert
 * on the byte sources passed through.
 *
 * Regression coverage for GH-136: bare-string file entries (the natural
 * shape) must be accepted by both the schema and the translator, and must
 * be forwarded to the SDK as-is. Previously the schema required
 * `{ data: string, encoding?: ... }` and the translator crashed on bare
 * strings with a cryptic "Unsupported byte source for X" error.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

mock.module("../allowance-auth.js", {
  namedExports: {
    requireAllowanceAuth: () => ({ headers: { "SIGN-IN-WITH-X": "dGVzdA==" } }),
  },
});

let lastApplySpec: unknown = null;
let lastApplyOpts: unknown = null;
let nextApplyImpl: (spec?: unknown, opts?: unknown) => Promise<unknown> = async () => ({
  release_id: "rel_001",
  operation_id: "op_001",
  urls: { deployment_id: "dpl_001", site_url: "https://dpl-001.sites.run402.com" },
  diff: { added: [], changed: [], removed: [] },
  warnings: [],
});

mock.module("../sdk.js", {
  namedExports: {
    getSdk: () => ({
      _applyEngine: {
        apply: async (spec: unknown, opts: unknown) => {
          lastApplySpec = spec;
          lastApplyOpts = opts;
          return nextApplyImpl(spec, opts);
        },
      },
    }),
    _resetSdk: () => {},
  },
});

const { handleDeploy, deploySchema } = await import("./deploy.js");
const { Run402DeployError } = await import("../../sdk/dist/index.js");
const { z } = await import("zod");

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-deploy-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";

  const store = {
    projects: {
      "prj_xxx": { anon_key: "ak-123", service_key: "sk-456" },
    },
  };
  writeFileSync(join(tempDir, "projects.json"), JSON.stringify(store));

  lastApplySpec = null;
  lastApplyOpts = null;
  nextApplyImpl = async () => ({
    release_id: "rel_001",
    operation_id: "op_001",
    urls: { deployment_id: "dpl_001", site_url: "https://dpl-001.sites.run402.com" },
    diff: { added: [], changed: [], removed: [] },
    warnings: [],
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("handleDeploy bare-string file entries (GH-136)", () => {
  it("accepts a bare-string site.replace entry and forwards it to the SDK as-is", async () => {
    const result = await handleDeploy({
      project_id: "prj_xxx",
      // The "natural" shape: file path → bare string body. Previously this
      // failed with "Unsupported byte source for qa29.html".
      site: { replace: { "qa29.html": "<h1>QA29</h1>" } as never } as never,
    });

    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.match(result.content[0].text, /Release Activated/);

    // Spec passed to the SDK must carry the bare string as the byte source.
    const spec = lastApplySpec as {
      site?: { replace?: Record<string, unknown> };
    };
    assert.ok(spec.site?.replace, "site.replace must be present in spec");
    assert.equal(
      spec.site!.replace!["qa29.html"],
      "<h1>QA29</h1>",
      "bare string must be forwarded to the SDK unchanged",
    );
  });

  it("still accepts the legacy `{ data, encoding }` object shape", async () => {
    const result = await handleDeploy({
      project_id: "prj_xxx",
      site: {
        replace: {
          "index.html": { data: "<h1>hi</h1>", encoding: "utf-8" },
          "logo.png": { data: "AAAA", encoding: "base64" },
        },
      },
    });

    assert.equal(result.isError, undefined, JSON.stringify(result));

    const spec = lastApplySpec as {
      site?: { replace?: Record<string, unknown> };
    };
    assert.ok(spec.site?.replace);
    // utf-8 entry is normalized to a bare string.
    assert.equal(spec.site!.replace!["index.html"], "<h1>hi</h1>");
    // base64 entry is normalized to a Uint8Array of decoded bytes.
    const png = spec.site!.replace!["logo.png"] as Uint8Array;
    assert.ok(png instanceof Uint8Array);
    assert.equal(png.length, 3); // "AAAA" base64 = 3 bytes (0x00 0x00 0x00)
    assert.deepEqual(Array.from(png), [0, 0, 0]);
  });

  it("accepts mixed bare-string and object entries in the same site.replace map", async () => {
    const result = await handleDeploy({
      project_id: "prj_xxx",
      site: {
        replace: {
          "a.html": "<h1>a</h1>" as never,
          "b.html": { data: "<h1>b</h1>" },
          "c.css": { data: "body{}", contentType: "text/css" },
        } as never,
      } as never,
    });

    assert.equal(result.isError, undefined, JSON.stringify(result));
    const spec = lastApplySpec as {
      site?: { replace?: Record<string, unknown> };
    };
    assert.equal(spec.site!.replace!["a.html"], "<h1>a</h1>");
    assert.equal(spec.site!.replace!["b.html"], "<h1>b</h1>");
    assert.deepEqual(spec.site!.replace!["c.css"], {
      data: "body{}",
      contentType: "text/css",
    });
  });

  it("accepts a bare-string site.patch.put entry", async () => {
    const result = await handleDeploy({
      project_id: "prj_xxx",
      site: {
        patch: {
          put: { "new.html": "<h1>new</h1>" as never } as never,
        },
      },
    });

    assert.equal(result.isError, undefined, JSON.stringify(result));
    const spec = lastApplySpec as {
      site?: { patch?: { put?: Record<string, unknown> } };
    };
    assert.equal(spec.site!.patch!.put!["new.html"], "<h1>new</h1>");
  });

  it("accepts a bare-string function source", async () => {
    const result = await handleDeploy({
      project_id: "prj_xxx",
      functions: {
        replace: {
          hello: {
            runtime: "node22",
            source: "export default () => new Response('ok');" as never,
          } as never,
        },
      },
    });

    assert.equal(result.isError, undefined, JSON.stringify(result));
    const spec = lastApplySpec as {
      functions?: { replace?: Record<string, { source?: unknown }> };
    };
    assert.equal(
      spec.functions!.replace!["hello"].source,
      "export default () => new Response('ok');",
    );
  });

  it("accepts a bare-string entry in a function `files` map", async () => {
    const result = await handleDeploy({
      project_id: "prj_xxx",
      functions: {
        replace: {
          api: {
            runtime: "node22",
            entrypoint: "index.mjs",
            files: {
              "index.mjs": "export default () => new Response('hi');" as never,
              "lib.mjs": "export const x = 1;" as never,
            } as never,
          } as never,
        },
      },
    });

    assert.equal(result.isError, undefined, JSON.stringify(result));
    const spec = lastApplySpec as {
      functions?: { replace?: Record<string, { files?: Record<string, unknown> }> };
    };
    assert.equal(
      spec.functions!.replace!["api"].files!["index.mjs"],
      "export default () => new Response('hi');",
    );
    assert.equal(
      spec.functions!.replace!["api"].files!["lib.mjs"],
      "export const x = 1;",
    );
  });
});

describe("handleDeploy deploy error formatting", () => {
  it("renders canonical deploy error context", async () => {
    nextApplyImpl = async () => {
      throw new Run402DeployError("Migration failed.", {
        code: "MIGRATION_FAILED",
        phase: "migrate",
        resource: "database.migrations.001_init",
        retryable: false,
        operationId: "op_1",
        planId: "plan_1",
        rolledBack: true,
        body: {
          message: "Migration failed.",
          code: "MIGRATION_FAILED",
          category: "deploy",
          retryable: false,
          safe_to_retry: true,
          attempts: 3,
          max_retries: 2,
          last_retry_code: "BASE_RELEASE_CONFLICT",
          mutation_state: "rolled_back",
          trace_id: "trc_tool",
          details: {
            statement_offset: 184,
            migration_id: "001_init",
          },
          next_actions: [
            { action: "edit_migration", label: "Fix migration SQL" },
            { action: "resume_deploy", label: "Resume after correction" },
          ],
        },
        context: "commit",
      });
    };

    const result = await handleDeploy({
      project_id: "prj_xxx",
      database: {
        migrations: [{ id: "001_init", sql: "select 1" }],
      },
    });
    const text = result.content[0]!.text;

    assert.equal(result.isError, true);
    assert.ok(text.includes("## Deploy Failed"));
    assert.ok(text.includes("Code: `MIGRATION_FAILED`"));
    assert.ok(text.includes("Category: deploy"));
    assert.ok(text.includes("Retryable: false"));
    assert.ok(text.includes("Safe to retry: true"));
    assert.ok(text.includes("Attempts: 3"));
    assert.ok(text.includes("Max retries: 2"));
    assert.ok(text.includes("Last retry code: `BASE_RELEASE_CONFLICT`"));
    assert.ok(text.includes("Mutation state: rolled_back"));
    assert.ok(text.includes("Trace: trc_tool"));
    assert.ok(text.includes("Details:"));
    assert.ok(text.includes('"statement_offset": 184'));
    assert.ok(text.includes("edit_migration: Fix migration SQL"));
    assert.ok(text.includes("resume_deploy: Resume after correction"));
    assert.ok(text.includes("**Phase:** `migrate`"));
    assert.ok(text.includes("**Resource:** `database.migrations.001_init`"));
    assert.ok(text.includes("**Operation:** `op_1`"));
    assert.ok(text.includes("**Plan:** `plan_1`"));
  });

  it("renders plan warnings outside the raw event stream", async () => {
    nextApplyImpl = async () => ({
      release_id: "rel_001",
      operation_id: "op_001",
      urls: {},
      diff: {},
      warnings: [
        {
          code: "MISSING_REQUIRED_SECRET",
          severity: "high",
          requires_confirmation: true,
          message: "OPENAI_API_KEY is missing",
          affected: ["OPENAI_API_KEY"],
        },
      ],
    });

    const result = await handleDeploy({
      project_id: "prj_xxx",
      secrets: { require: ["OPENAI_API_KEY"] },
    });

    const text = result.content[0]!.text;
    assert.equal(result.isError, undefined);
    assert.ok(text.includes("### Plan warnings"));
    assert.ok(text.includes("MISSING_REQUIRED_SECRET"));
    assert.ok(text.includes("set_secret"));
    assert.deepEqual((lastApplySpec as { secrets?: unknown }).secrets, {
      require: ["OPENAI_API_KEY"],
    });
  });

  it("preserves deploy.retry progress events", async () => {
    nextApplyImpl = async (_spec, opts) => {
      const onEvent = (opts as { onEvent?: (event: unknown) => void }).onEvent;
      onEvent?.({
        type: "deploy.retry",
        attempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 250,
        code: "BASE_RELEASE_CONFLICT",
        phase: "apply",
        resource: "release",
        operationId: "op_1",
        planId: "plan_1",
        message: "Another deploy activated a release.",
      });
      return {
        release_id: "rel_001",
        operation_id: "op_001",
        urls: {},
        diff: {},
        warnings: [],
      };
    };

    const result = await handleDeploy({
      project_id: "prj_xxx",
      site: { replace: { "index.html": "hello" } as never } as never,
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[1]!.text.includes('"type": "deploy.retry"'));
    assert.ok(result.content[1]!.text.includes('"code": "BASE_RELEASE_CONFLICT"'));
  });

  it("passes allow_warnings through to the SDK option", async () => {
    await handleDeploy({
      project_id: "prj_xxx",
      secrets: { delete: ["OLD_KEY"] },
      allow_warnings: true,
    });
    assert.equal((lastApplyOpts as { allowWarnings?: boolean }).allowWarnings, true);
  });

  it("passes allow_warning_codes through to the SDK option", async () => {
    await handleDeploy({
      project_id: "prj_xxx",
      secrets: { delete: ["OLD_KEY"] },
      allow_warning_codes: ["WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS"],
    });
    assert.deepEqual((lastApplyOpts as { allowWarningCodes?: string[] }).allowWarningCodes, [
      "WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS",
    ]);
  });

  it("passes route manifests through and includes raw deploy result JSON", async () => {
    nextApplyImpl = async () => ({
      release_id: "rel_001",
      operation_id: "op_001",
      urls: {},
      diff: {
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
      },
      warnings: [],
    });

    const result = await handleDeploy({
      project_id: "prj_xxx",
      routes: {
        replace: [
          {
            pattern: "/api/*",
            target: { type: "function", name: "api" },
          },
        ],
      },
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual((lastApplySpec as { routes?: unknown }).routes, {
      replace: [
        {
          pattern: "/api/*",
          target: { type: "function", name: "api" },
        },
      ],
    });
    assert.match(result.content[0]!.text, /Raw Deploy Result/);
    assert.match(result.content[0]!.text, /"routes"/);
  });

  it("passes site.public_paths through the SDK manifest adapter", async () => {
    const result = await handleDeploy({
      project_id: "prj_xxx",
      site: {
        replace: { "events.html": "<h1>events</h1>" },
        public_paths: {
          mode: "explicit",
          replace: {
            "/events": { asset: "events.html", cache_class: "html" },
          },
        },
      },
    });

    assert.equal(result.isError, undefined, JSON.stringify(result));
    const spec = lastApplySpec as {
      site?: {
        replace?: Record<string, unknown>;
        public_paths?: unknown;
      };
    };
    assert.equal(spec.site?.replace?.["events.html"], "<h1>events</h1>");
    assert.deepEqual(spec.site?.public_paths, {
      mode: "explicit",
      replace: {
        "/events": { asset: "events.html", cache_class: "html" },
      },
    });
  });

  it("surfaces SDK manifest adapter errors for malformed site.public_paths", async () => {
    const result = await handleDeploy({
      project_id: "prj_xxx",
      site: {
        public_paths: {
          mode: "implicit",
          replace: { "/events": { asset: "events.html" } },
        } as never,
      },
    });

    assert.equal(result.isError, true);
    assert.equal(lastApplySpec, null);
    assert.match(result.content[0]!.text, /site\.public_paths\.replace|implicit mode/);
  });

  it("renders route-specific warning guidance", async () => {
    nextApplyImpl = async () => ({
      release_id: "rel_001",
      operation_id: "op_001",
      urls: {},
      diff: {},
      warnings: [
        {
          code: "PUBLIC_ROUTED_FUNCTION",
          severity: "high",
          requires_confirmation: true,
          message: "api is public",
          affected: ["functions.api"],
        },
      ],
    });

    const result = await handleDeploy({
      project_id: "prj_xxx",
      routes: { replace: [] },
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0]!.text, /Route warning guidance/);
    assert.match(result.content[0]!.text, /CSRF/);
    assert.match(result.content[0]!.text, /allow_warnings/);
  });

  it("renders route-specific deploy error guidance", async () => {
    nextApplyImpl = async () => {
      throw new Run402DeployError("Routes are not enabled.", {
        code: "ROUTES_NOT_ENABLED",
        phase: "plan",
        resource: "routes",
        retryable: false,
      });
    };

    const result = await handleDeploy({
      project_id: "prj_xxx",
      routes: { replace: [] },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /Route warning guidance/);
    assert.match(result.content[0]!.text, /not enabled/);
    assert.match(result.content[0]!.text, /browser-route substitute/);
  });

  it("renders unacknowledged warning codes for deploy warning errors", async () => {
    nextApplyImpl = async () => {
      throw new Run402DeployError("Warnings require confirmation.", {
        code: "MISSING_REQUIRED_SECRET",
        phase: "plan",
        resource: "warnings",
        retryable: false,
        body: {
          warnings: [
            {
              code: "MISSING_REQUIRED_SECRET",
              severity: "high",
              requires_confirmation: true,
              message: "OPENAI_API_KEY is missing",
              affected: ["OPENAI_API_KEY"],
            },
          ],
          unacknowledged_warning_codes: ["MISSING_REQUIRED_SECRET"],
        },
      });
    };

    const result = await handleDeploy({
      project_id: "prj_xxx",
      secrets: { require: ["OPENAI_API_KEY"] },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /Unacknowledged warning code/);
    assert.match(result.content[0]!.text, /MISSING_REQUIRED_SECRET/);
    assert.match(result.content[0]!.text, /set_secret/);
  });
});

describe("deploySchema fileEntry parsing", () => {
  // Build an inline schema that mirrors the one MCP composes for the `site`
  // arg, so we can validate the union shape directly.
  const schema = z.object({ site: deploySchema.site });
  const secretsSchema = z.object({ secrets: deploySchema.secrets });
  const routesSchema = z.object({ routes: deploySchema.routes });

  it("parses a bare string in site.replace", () => {
    const r = schema.safeParse({
      site: { replace: { "p.html": "<h1>x</h1>" } },
    });
    assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.issues));
  });

  it("parses a `{ data, encoding }` object in site.replace", () => {
    const r = schema.safeParse({
      site: { replace: { "p.html": { data: "<h1>x</h1>", encoding: "utf-8" } } },
    });
    assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.issues));
  });

  it("parses both shapes mixed in the same map", () => {
    const r = schema.safeParse({
      site: {
        replace: {
          "a.html": "<h1>a</h1>",
          "b.html": { data: "<h1>b</h1>" },
        },
      },
    });
    assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.issues));
  });

  it("parses explicit and implicit site.public_paths", () => {
    const explicit = schema.safeParse({
      site: {
        replace: { "events.html": "<h1>events</h1>" },
        public_paths: {
          mode: "explicit",
          replace: {
            "/events": { asset: "events.html", cache_class: "html" },
          },
        },
      },
    });
    assert.equal(explicit.success, true, explicit.success ? "" : JSON.stringify(explicit.error.issues));

    const implicitOnly = schema.safeParse({
      site: { public_paths: { mode: "implicit" } },
    });
    assert.equal(implicitOnly.success, true, implicitOnly.success ? "" : JSON.stringify(implicitOnly.error.issues));
  });

  it("rejects malformed site.public_paths at the schema edge", () => {
    assert.equal(
      schema.safeParse({
        site: {
          public_paths: {
            mode: "implicit",
            replace: { "/events": { asset: "events.html" } },
          },
        },
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        site: {
          public_paths: {
            mode: "explicit",
            replace: { "/events": { asset: "events.html", headers: {} } },
          },
        },
      }).success,
      false,
    );
  });

  it("rejects a non-string non-object value in site.replace", () => {
    const r = schema.safeParse({
      site: { replace: { "p.html": 42 } },
    });
    assert.equal(r.success, false);
  });

  it("accepts value-free secrets.require/delete", () => {
    const r = secretsSchema.safeParse({
      secrets: { require: ["OPENAI_API_KEY"], delete: ["OLD_KEY"] },
    });
    assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.issues));
  });

  it("rejects legacy secrets.set and replace_all", () => {
    for (const secrets of [
      { set: { OPENAI_API_KEY: { value: "sk" } } },
      { replace_all: { OPENAI_API_KEY: { value: "sk" } } },
    ]) {
      const r = secretsSchema.safeParse({ secrets });
      assert.equal(r.success, false);
    }
  });

  it("parses route replace manifests and rejects path-keyed maps", () => {
    const valid = routesSchema.safeParse({
      routes: {
        replace: [
          {
            pattern: "/api/*",
            methods: ["GET", "POST"],
            target: { type: "function", name: "api" },
          },
          {
            pattern: "/share/*",
            methods: ["GET"],
            target: { type: "function", name: "share" },
            acknowledge_readonly: true,
          },
        ],
      },
    });
    assert.equal(valid.success, true, valid.success ? "" : JSON.stringify(valid.error.issues));

    const staticRoute = routesSchema.safeParse({
      routes: {
        replace: [
          {
            pattern: "/events",
            methods: ["GET", "HEAD"],
            target: { type: "static", file: "events.html" },
          },
        ],
      },
    });
    assert.equal(staticRoute.success, true, staticRoute.success ? "" : JSON.stringify(staticRoute.error.issues));

    assert.equal(routesSchema.safeParse({ routes: { replace: [] } }).success, true);
    assert.equal(routesSchema.safeParse({ routes: null }).success, true);
    assert.equal(routesSchema.safeParse({ routes: { "/api/*": { function: "api" } } }).success, false);
    assert.equal(
      routesSchema.safeParse({
        routes: { replace: [{ pattern: "/api/*", methods: [], target: { type: "function", name: "api" } }] },
      }).success,
      false,
    );
  });
});
