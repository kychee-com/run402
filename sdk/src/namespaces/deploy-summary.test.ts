import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  summarizeDeployResult,
  type DeployResult,
  type DeploySummary,
} from "../index.js";
import { summarizeDeployResult as summarizeDeployResultFromNode } from "../node/index.js";

function baseResult(overrides: Partial<DeployResult> = {}): DeployResult {
  return {
    release_id: "rel_123",
    operation_id: "op_123",
    urls: { app: "https://example.run402.app" },
    diff: {},
    warnings: [],
    ...overrides,
  };
}

describe("summarizeDeployResult", () => {
  it("summarizes modern static asset counts, CAS bytes, and warnings", () => {
    const result = baseResult({
      diff: {
        is_noop: false,
        site: {
          added: [],
          removed: [],
          changed: [
            {
              path: "js/env.js",
              sha256_old: "old",
              sha256_new: "new",
              content_type_old: "application/javascript",
              content_type_new: "application/javascript",
            },
          ],
        },
        static_assets: {
          unchanged: 152,
          changed: 1,
          added: 0,
          removed: 0,
          newly_uploaded_cas_bytes: 331,
          reused_cas_bytes: 72_368_346,
          deployment_copy_bytes_eliminated: 10_000,
          legacy_immutable_warnings: [],
          previous_immutable_failures: [],
          cas_authorization_failures: [],
        },
        functions: { added: [], removed: [], changed: [] },
      },
      warnings: [
        {
          code: "ROUTE_SHADOWS_STATIC_PATH",
          severity: "warn",
          requires_confirmation: true,
          message: "Route shadows a static path.",
        },
        {
          code: "MISSING_REQUIRED_SECRET",
          severity: "high",
          requires_confirmation: false,
          message: "Missing secret.",
        },
        {
          code: "ROUTE_SHADOWS_STATIC_PATH",
          severity: "warn",
          requires_confirmation: false,
          message: "Duplicate code for sorting/dedupe coverage.",
        },
      ],
    });

    const summary = summarizeDeployResult(result);

    assert.equal(summary.schema_version, "deploy-summary.v1");
    assert.equal(summary.release_id, "rel_123");
    assert.equal(summary.operation_id, "op_123");
    assert.equal(summary.is_noop, false);
    assert.deepEqual(summary.site?.paths, {
      added: 0,
      changed: 1,
      removed: 0,
      unchanged: 152,
      total_changed: 1,
    });
    assert.deepEqual(summary.site?.cas, {
      newly_uploaded_bytes: 331,
      reused_bytes: 72_368_346,
      deployment_copy_bytes_eliminated: 10_000,
    });
    assert.deepEqual(summary.warnings, {
      count: 3,
      blocking: 2,
      codes: ["MISSING_REQUIRED_SECRET", "ROUTE_SHADOWS_STATIC_PATH"],
    });
    assert.match(summary.headline, /1 static path changed/);
    assert.match(summary.headline, /331 B uploaded/);
    assert.match(summary.headline, /72\.4 MB reused/);
    assert.match(summary.headline, /no functions changed/);
  });

  it("summarizes site diffs without fabricating static asset counters", () => {
    const summary = summarizeDeployResult(baseResult({
      diff: {
        site: {
          added: [
            { path: "new.html", sha256: "new", content_type: "text/html" },
          ],
          removed: ["old.html"],
          changed: [
            {
              path: "index.html",
              sha256_old: "old",
              sha256_new: "new",
              content_type_old: "text/html",
              content_type_new: "text/html",
            },
          ],
        },
      },
    }));

    assert.deepEqual(summary.site?.paths, {
      added: 1,
      changed: 1,
      removed: 1,
      total_changed: 3,
    });
    assert.equal(summary.site?.cas, undefined);
    assert.equal("unchanged" in summary.site!.paths!, false);
  });

  it("omits missing and legacy-shaped buckets instead of zero-filling them", () => {
    const summary = summarizeDeployResult(baseResult({
      diff: {
        migrations: [
          { id: "001_init", state: "new" },
          { id: "002_noop", state: "noop" },
        ],
        routes: [{ kind: "added", path: "/api/*" }],
        subdomains: [{ kind: "added", subdomain: "app" }],
      },
    }));

    assert.equal(summary.migrations, undefined);
    assert.equal(summary.routes, undefined);
    assert.equal(summary.subdomains, undefined);
    assert.equal(summary.site, undefined);
    assert.equal(summary.functions, undefined);
    assert.deepEqual(summary.warnings, { count: 0, blocking: 0, codes: [] });
  });

  it("summarizes functions, migrations, routes, secrets, and subdomains from modern buckets", () => {
    const summary = summarizeDeployResult(baseResult({
      diff: {
        functions: {
          added: ["api"],
          removed: ["old-worker"],
          changed: [
            {
              name: "cron",
              fields_changed: ["code_hash", "schedule"],
            },
          ],
        },
        migrations: {
          new: [
            { id: "001_init", checksum_hex: "abc", transaction: "default" },
          ],
          noop: [{ id: "000_base", checksum_hex: "def" }],
        },
        routes: {
          added: [],
          removed: [],
          changed: [
            {
              pattern: "/api/*",
              before: {
                pattern: "/api/*",
                kind: "prefix",
                prefix: "/api/",
                methods: null,
                target: { type: "function", name: "old-api" },
              },
              after: {
                pattern: "/api/*",
                kind: "prefix",
                prefix: "/api/",
                methods: null,
                target: { type: "function", name: "api" },
              },
              fields_changed: ["target"],
            },
          ],
        },
        secrets: { added: ["OPENAI_API_KEY"], removed: ["OLD_SECRET"] },
        subdomains: { added: ["app"], removed: [] },
      },
    }));

    assert.deepEqual(summary.functions, {
      added: ["api"],
      removed: ["old-worker"],
      changed: [
        {
          name: "cron",
          fields_changed: ["code_hash", "schedule"],
        },
      ],
    });
    assert.equal("code_hash_old" in summary.functions!.changed[0]!, false);
    assert.equal("code_hash_new" in summary.functions!.changed[0]!, false);
    assert.deepEqual(summary.migrations, {
      new: ["001_init"],
      noop: ["000_base"],
    });
    assert.deepEqual(summary.routes, { added: 0, changed: 1, removed: 0 });
    assert.deepEqual(summary.secrets, { added: 1, removed: 1 });
    assert.deepEqual(summary.subdomains, { added: 1, removed: 0 });
  });

  it("does not expose timing or duration fields", () => {
    const summary = summarizeDeployResult(baseResult({
      diff: { is_noop: true },
    })) as DeploySummary & Record<string, unknown>;

    assert.equal("timings" in summary, false);
    assert.equal("duration_ms" in summary, false);
    assert.equal("phase_durations" in summary, false);
    assert.equal(summary.headline, "no deploy changes reported");
  });

  it("is re-exported from the Node entry point", () => {
    assert.equal(summarizeDeployResultFromNode, summarizeDeployResult);
    const summary: DeploySummary = summarizeDeployResultFromNode(baseResult());
    assert.equal(summary.schema_version, "deploy-summary.v1");
  });
});
