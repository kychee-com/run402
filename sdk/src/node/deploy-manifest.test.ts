import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { LocalError } from "../errors.js";
import {
  loadDeployManifest,
  normalizeDeployManifest,
} from "./deploy-manifest.js";

describe("Node deploy manifest helpers", () => {
  it("normalizes MCP/CLI manifest fields into an SDK ReleaseSpec", async () => {
    const normalized = await normalizeDeployManifest({
      $schema: "https://run402.com/schemas/release-spec.v1.json",
      project_id: "prj_manifest",
      idempotency_key: "idem_1",
      site: {
        replace: {
          "index.html": { data: "<h1>hi</h1>", encoding: "utf-8" },
          "logo.png": {
            data: "AAAA",
            encoding: "base64",
            contentType: "image/png",
          },
        },
      },
      functions: {
        replace: {
          api: {
            runtime: "node22",
            entrypoint: "index.mjs",
            files: {
              "index.mjs": "export default () => new Response('ok');",
            },
          },
        },
      },
      routes: {
        replace: [
          {
            pattern: "/api/*",
            methods: ["GET", "POST"],
            target: { type: "function", name: "api" },
          },
        ],
      },
    });

    assert.equal(normalized.spec.project, "prj_manifest");
    assert.equal("$schema" in normalized.spec, false);
    assert.equal(normalized.manifest.$schema, "https://run402.com/schemas/release-spec.v1.json");
    assert.equal(normalized.idempotencyKey, "idem_1");
    assert.equal(
      normalized.spec.site &&
        "replace" in normalized.spec.site &&
        normalized.spec.site.replace["index.html"],
      "<h1>hi</h1>",
    );
    const png =
      normalized.spec.site &&
      "replace" in normalized.spec.site &&
      normalized.spec.site.replace["logo.png"];
    assert.deepEqual(png, {
      data: new Uint8Array([0, 0, 0]),
      contentType: "image/png",
    });
    assert.equal(
      normalized.spec.functions?.replace?.api.files?.["index.mjs"],
      "export default () => new Response('ok');",
    );
    assert.deepEqual(normalized.spec.routes, {
      replace: [
        {
          pattern: "/api/*",
          methods: ["GET", "POST"],
          target: { type: "function", name: "api" },
        },
      ],
    });
  });

  it("preserves routes:null through manifest normalization", async () => {
    const normalized = await normalizeDeployManifest({
      project_id: "prj_manifest",
      routes: null,
      site: { patch: { delete: ["old.html"] } },
    });

    assert.equal(normalized.spec.routes, null);
  });

  it("preserves static route targets through manifest normalization", async () => {
    const normalized = await normalizeDeployManifest({
      project_id: "prj_manifest",
      site: { replace: { "events.html": "<h1>events</h1>" } },
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

    assert.deepEqual(normalized.spec.routes, {
      replace: [
        {
          pattern: "/events",
          methods: ["GET", "HEAD"],
          target: { type: "static", file: "events.html" },
        },
      ],
    });
  });

  it("preserves read-only wildcard route acknowledgement through manifest normalization", async () => {
    const normalized = await normalizeDeployManifest({
      project_id: "prj_manifest",
      routes: {
        replace: [
          {
            pattern: "/share/*",
            methods: ["GET", "HEAD"],
            target: { type: "function", name: "share" },
            acknowledge_readonly: true,
          },
        ],
      },
    });

    assert.deepEqual(normalized.spec.routes, {
      replace: [
        {
          pattern: "/share/*",
          methods: ["GET", "HEAD"],
          target: { type: "function", name: "share" },
          acknowledge_readonly: true,
        },
      ],
    });
  });

  it("normalizes explicit site public paths", async () => {
    const normalized = await normalizeDeployManifest({
      project_id: "prj_manifest",
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

    assert.equal(normalized.spec.project, "prj_manifest");
    assert.deepEqual(normalized.spec.site?.public_paths, {
      mode: "explicit",
      replace: {
        "/events": { asset: "events.html", cache_class: "html" },
      },
    });
  });

  it("normalizes implicit and public-path-only site manifests", async () => {
    const implicit = await normalizeDeployManifest({
      project_id: "prj_manifest",
      site: { public_paths: { mode: "implicit" } },
    });
    assert.deepEqual(implicit.spec.site, {
      public_paths: { mode: "implicit" },
    });

    const noDirectPublicPaths = await normalizeDeployManifest({
      project_id: "prj_manifest",
      site: { public_paths: { mode: "explicit", replace: {} } },
    });
    assert.deepEqual(noDirectPublicPaths.spec.site, {
      public_paths: { mode: "explicit", replace: {} },
    });
  });

  it("loads manifest files relative to their directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-deploy-manifest-test-"));
    try {
      writeFileSync(join(root, "index.html"), "<h1>from file</h1>");
      writeFileSync(join(root, "001_init.sql"), "select 1;");
      const manifestPath = join(root, "run402.deploy.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          project_id: "prj_file",
          database: {
            migrations: [{ id: "001_init", sql_path: "001_init.sql" }],
          },
          site: {
            replace: {
              "index.html": { path: "index.html", contentType: "text/html" },
            },
          },
        }),
      );

      const normalized = await loadDeployManifest(manifestPath);

      assert.equal(normalized.manifestPath, manifestPath);
      assert.equal(
        normalized.spec.database?.migrations?.[0]?.sql,
        "select 1;",
      );
      const source =
        normalized.spec.site &&
        "replace" in normalized.spec.site &&
        normalized.spec.site.replace["index.html"];
      assert.deepEqual(source, {
        __source: "fs-file",
        path: join(root, "index.html"),
        contentType: "text/html",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown manifest fields instead of silently dropping them", async () => {
    for (const input of [
      {
        project_id: "prj_manifest",
        subdomain: "my-app",
        site: { replace: { "index.html": "hi" } },
      },
      {
        project_id: "prj_manifest",
        database: { migratoins: [{ id: "001", sql: "select 1;" }] },
      },
      {
        project_id: "prj_manifest",
        database: { migrations: [{ id: "001", sqlPath: "001.sql" }] },
      },
      {
        project_id: "prj_manifest",
        functions: { patch: { remove: ["api"] } },
      },
      {
        project_id: "prj_manifest",
        site: { replace: { "index.html": "hi" }, patch: { delete: ["old.html"] } },
      },
      {
        project_id: "prj_manifest",
        site: { public_paths: { mode: "explicit", patch: {} } },
      },
      {
        project_id: "prj_manifest",
        site: { public_paths: { mode: "implicit", replace: { "/events": { asset: "events.html" } } } },
      },
      {
        "$schema": "https://run402.com/schemas/release-spec.v1.json",
        project_id: "prj_manifest",
        site: { public_paths: { mode: "explicit", replace: { "/events": { headers: {} } } } },
      },
    ]) {
      await assert.rejects(
        () => normalizeDeployManifest(input as never),
        (err: unknown) => {
          assert.ok(err instanceof LocalError);
          assert.match((err as Error).message, /Unknown|either replace or patch|implicit mode|asset/);
          return true;
        },
      );
    }
  });

  it("detects project override conflicts before deploy.apply", async () => {
    await assert.rejects(
      () =>
        normalizeDeployManifest(
          { project_id: "prj_manifest", site: { replace: { "x.txt": "x" } } },
          { project: "prj_flag" },
        ),
      (err: unknown) => {
        assert.ok(err instanceof LocalError);
        assert.match((err as Error).message, /project conflict/);
        assert.match((err as Error).message, /prj_manifest/);
        assert.match((err as Error).message, /prj_flag/);
        return true;
      },
    );
  });

  it("rejects malformed route shapes with actionable messages", async () => {
    for (const [input, pattern] of [
      [
        { project_id: "prj_manifest", routes: { "/api/*": { function: "api" } } },
        /Path-keyed route maps|routes\.replace/,
      ],
      [
        { project_id: "prj_manifest", routes: { replace: { pattern: "/api/*" } } },
        /routes\.replace must be an array/,
      ],
      [
        {
          project_id: "prj_manifest",
          routes: { replace: [{ pattern: "/api/*", methods: [], target: { type: "function", name: "api" } }] },
        },
        /omit methods/,
      ],
      [
        {
          project_id: "prj_manifest",
          routes: { replace: [{ pattern: "/api/*", methods: ["TRACE"], target: { type: "function", name: "api" } }] },
        },
        /unsupported method/,
      ],
      [
        {
          project_id: "prj_manifest",
          routes: { replace: [{ pattern: "/api/*", target: { function: "api" } }] },
        },
        /target shorthand/,
      ],
      [
        {
          project_id: "prj_manifest",
          routes: { replace: [{ pattern: "/events", methods: ["GET"], target: { type: "static", file: "/events.html" } }] },
        },
        /relative materialized static-site file path/,
      ],
      [
        {
          project_id: "prj_manifest",
          routes: { replace: [{ pattern: "/events", methods: ["POST"], target: { type: "static", file: "events.html" } }] },
        },
        /static route targets must be/,
      ],
      [
        {
          project_id: "prj_manifest",
          routes: { replace: [{ pattern: "/docs/*", methods: ["GET"], target: { type: "static", file: "docs/index.html" } }] },
        },
        /exact path pattern/,
      ],
      [
        {
          project_id: "prj_manifest",
          routes: { replace: [{ pattern: "/api/*", methods: ["GET", "GET"], target: { type: "function", name: "api" } }] },
        },
        /duplicate method/,
      ],
      [
        {
          project_id: "prj_manifest",
          routes: { replace: [{ pattern: "/share", methods: ["GET"], target: { type: "function", name: "share" }, acknowledge_readonly: true }] },
        },
        /GET\/HEAD final-wildcard function routes/,
      ],
      [
        {
          project_id: "prj_manifest",
          routes: { replace: [{ pattern: "/share/*", methods: ["GET", "POST"], target: { type: "function", name: "share" }, acknowledge_readonly: true }] },
        },
        /GET\/HEAD final-wildcard function routes/,
      ],
      [
        {
          project_id: "prj_manifest",
          routes: { replace: [{ pattern: "/share/*", methods: ["GET"], target: { type: "function", name: "share" }, acknowledge_readonly: false }] },
        },
        /must be true/,
      ],
    ] as const) {
      await assert.rejects(
        () => normalizeDeployManifest(input as never),
        (err: unknown) => {
          assert.ok(err instanceof LocalError);
          assert.match((err as Error).message, pattern);
          return true;
        },
      );
    }
  });
});
