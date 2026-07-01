import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { LocalError } from "../errors.js";
import {
  loadDeployManifest,
  loadExecutableDeployConfig,
  normalizeDeployManifest,
} from "./deploy-manifest.js";

describe("Node deploy manifest helpers", () => {
  it("loads explicit executable TypeScript deploy configs", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-exec-config-"));
    try {
      mkdirSync(join(root, "dist"), { recursive: true });
      mkdirSync(join(root, "db"), { recursive: true });
      mkdirSync(join(root, "functions"), { recursive: true });
      writeFileSync(join(root, "dist", "index.html"), "<h1>typed</h1>");
      writeFileSync(join(root, "db", "001_init.sql"), "select 1;\n");
      writeFileSync(join(root, "functions", "api.mjs"), "export default () => new Response('ok');\n");
      const helperUrl = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "config.ts")).href;
      const manifestPath = join(root, "run402.deploy.ts");
      writeFileSync(manifestPath, `
        import { defineConfig, dir, emailTrigger, file, nodeFunction, scheduleTrigger, sqlFile } from ${JSON.stringify(helperUrl)};
        export default defineConfig({
          project: "prj_typed",
          site: { replace: dir("./dist"), public_paths: { mode: "implicit" } },
          database: { migrations: [sqlFile("./db/001_init.sql")] },
          functions: { replace: { api: nodeFunction("./functions/api.mjs", {
            triggers: [
              scheduleTrigger("maintenance_every_15m", "*/15 * * * *", {
                run: { event_type: "maintenance", payload: { sweep: true } },
              }),
              emailTrigger("mail_events", "signing-inbox", {
                events: ["reply_received"],
                run: { event_type: "email.event" },
              }),
            ],
          }) } },
          assets: { put: [{ key: "logo.txt", source: file("./dist/index.html") }] },
        });
      `);

      const normalized = await loadDeployManifest(manifestPath);
      assert.equal(normalized.spec.project, "prj_typed");
      assert.equal(normalized.manifestPath, manifestPath);
      assert.deepEqual(normalized.spec.site && "replace" in normalized.spec.site && normalized.spec.site.replace, {
        __source: "local-dir",
        path: join(root, "dist"),
      });
      assert.equal(normalized.spec.database?.migrations?.[0]?.sql, "select 1;\n");
      assert.equal(
        (normalized.spec.functions?.replace?.api.source as { path?: string }).path,
        join(root, "functions", "api.mjs"),
      );
      assert.deepEqual(normalized.spec.functions?.replace?.api.triggers, [
        {
          id: "maintenance_every_15m",
          type: "schedule",
          cron: "*/15 * * * *",
          run: { event_type: "maintenance", payload: { sweep: true } },
        },
        {
          id: "mail_events",
          type: "email",
          mailbox: "signing-inbox",
          events: ["reply_received"],
          run: { event_type: "email.event" },
        },
      ]);
      assert.equal(
        (normalized.spec.assets?.put?.[0] as { source?: { path?: string } }).source?.path,
        join(root, "dist", "index.html"),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("loads explicit executable TS, MTS, CJS, and MJS deploy configs", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-exec-config-exts-"));
    try {
      const cases = [
        ["run402.deploy.ts", 'export default { project: "prj_ts", site: { public_paths: { mode: "implicit" } } };'],
        ["run402.deploy.mjs", 'export default { project: "prj_mjs", site: { public_paths: { mode: "implicit" } } };'],
        ["run402.deploy.cjs", 'module.exports = { project: "prj_cjs", site: { public_paths: { mode: "implicit" } } };'],
        ["run402.deploy.mts", 'export default { project: "prj_mts", site: { public_paths: { mode: "implicit" } } };'],
      ] as const;

      for (const [fileName, source] of cases) {
        const manifestPath = join(root, fileName);
        writeFileSync(manifestPath, source);
        const normalized = await loadDeployManifest(manifestPath);
        assert.equal(normalized.spec.project, `prj_${fileName.split(".").at(-1)}`);
        assert.equal(normalized.manifestPath, manifestPath);
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects executable configs with missing or non-object exports", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-exec-config-invalid-"));
    try {
      const cases = [
        ["missing.mjs", "export const unrelated = true;"],
        ["primitive.mjs", "export default 123;"],
      ] as const;
      for (const [fileName, source] of cases) {
        const manifestPath = join(root, fileName);
        writeFileSync(manifestPath, source);
        await assert.rejects(
          () => loadExecutableDeployConfig(manifestPath),
          (err: unknown) => err instanceof LocalError && err.code === "EXECUTABLE_CONFIG_INVALID_EXPORT",
        );
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("wraps executable config throw and rejection with a stable local code", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-exec-config-throws-"));
    try {
      const cases = [
        ["throws.mjs", "export default () => { throw new Error('boom sync'); };"],
        ["rejects.mjs", "export default async () => { throw new Error('boom async'); };"],
      ] as const;
      for (const [fileName, source] of cases) {
        const manifestPath = join(root, fileName);
        writeFileSync(manifestPath, source);
        await assert.rejects(
          () => loadExecutableDeployConfig(manifestPath),
          (err: unknown) => {
            assert.ok(err instanceof LocalError);
            assert.equal(err.code, "EXECUTABLE_CONFIG_EVALUATION_FAILED");
            assert.match(err.message, /boom/);
            return true;
          },
        );
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("times out hanging executable config functions", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-exec-config-timeout-"));
    try {
      const manifestPath = join(root, "run402.deploy.mjs");
      writeFileSync(manifestPath, "export default () => new Promise(() => {});");
      await assert.rejects(
        () => loadExecutableDeployConfig(manifestPath, { timeoutMs: 20 }),
        (err: unknown) => {
          assert.ok(err instanceof LocalError);
          assert.equal(err.code, "EXECUTABLE_CONFIG_TIMEOUT");
          assert.equal((err as LocalError).details?.timeout_ms, 20);
          return true;
        },
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("captures env helper metadata from executable configs", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-exec-config-env-"));
    try {
      const manifestPath = join(root, "run402.deploy.mjs");
      writeFileSync(manifestPath, `
        export default ({ env, manifestPath, rootDir }) => ({
          project: env.required("RUN402_PROJECT_ID"),
          checks: [{ name: "root", url: env.get("RUN402_CHECK_URL") ?? rootDir }],
          site: { replace: { "meta.txt": { data: manifestPath } } },
        });
      `);
      const normalized = await loadDeployManifest(manifestPath, {
        env: {
          RUN402_PROJECT_ID: "prj_env",
          RUN402_CHECK_URL: "https://example.test/health",
        },
      });

      assert.equal(normalized.spec.project, "prj_env");
      assert.deepEqual(normalized.config?.env_accessed, ["RUN402_CHECK_URL", "RUN402_PROJECT_ID"]);
      assert.equal(normalized.spec.checks?.[0]?.url, "https://example.test/health");
      assert.equal(
        normalized.spec.site &&
          "replace" in normalized.spec.site &&
          normalized.spec.site.replace["meta.txt"],
        manifestPath,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("throws a structured local error for missing required config env", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-exec-config-env-required-"));
    try {
      const manifestPath = join(root, "run402.deploy.mjs");
      writeFileSync(manifestPath, `
        export default ({ env }) => ({
          project: env.required("RUN402_PROJECT_ID"),
        });
      `);

      await assert.rejects(
        () => loadExecutableDeployConfig(manifestPath, { env: {} }),
        (err: unknown) => {
          assert.ok(err instanceof LocalError);
          assert.equal(err.code, "CONFIG_ENV_REQUIRED");
          assert.deepEqual(err.details, { name: "RUN402_PROJECT_ID" });
          assert.equal(err.context, "evaluating executable deploy config");
          return true;
        },
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects missing local sqlFile references during executable config normalization", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-exec-config-missing-file-"));
    try {
      const helperUrl = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "config.ts")).href;
      const manifestPath = join(root, "run402.deploy.ts");
      writeFileSync(manifestPath, `
        import { defineConfig, sqlFile } from ${JSON.stringify(helperUrl)};
        export default defineConfig({
          project: "prj_missing",
          database: { migrations: [sqlFile("./db/missing.sql")] },
        });
      `);

      await assert.rejects(
        () => loadDeployManifest(manifestPath),
        (err: unknown) => {
          assert.ok(err instanceof LocalError);
          assert.match(err.message, /Failed to read migration sql_file/);
          return true;
        },
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects unbundled TypeScript function sources in executable configs", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-exec-config-ts-fn-"));
    try {
      mkdirSync(join(root, "functions"), { recursive: true });
      writeFileSync(join(root, "functions", "api.ts"), "export default () => new Response('ok');\n");
      const helperUrl = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "config.ts")).href;
      const manifestPath = join(root, "run402.deploy.ts");
      writeFileSync(manifestPath, `
        import { defineConfig, nodeFunction } from ${JSON.stringify(helperUrl)};
        export default defineConfig({
          project: "prj_typed",
          functions: { replace: { api: nodeFunction("./functions/api.ts") } },
        });
      `);

      await assert.rejects(
        () => loadDeployManifest(manifestPath),
        (err) => err instanceof LocalError && err.code === "TYPESCRIPT_FUNCTION_REQUIRES_BUNDLE",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

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
            content_type: "image/png",
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

  it("strips app-kit omitted-feature evidence before deploy planning", async () => {
    const normalized = await normalizeDeployManifest({
      project_id: "prj_manifest",
      "x-run402-omitted_features": [{
        resource: "functions.email-webhook",
        capability: "email.managed",
        reason: "Managed email is Cloud-only for this Core build.",
      }],
      site: { replace: { "index.html": "<h1>hi</h1>" } },
    });

    assert.equal("x-run402-omitted_features" in normalized.spec, false);
    assert.equal(Array.isArray(normalized.manifest["x-run402-omitted_features"]), true);
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

  it("preserves a full i18n slice through manifest normalization", async () => {
    const normalized = await normalizeDeployManifest({
      project_id: "prj_manifest",
      site: { replace: { "index.html": "<h1>hi</h1>" } },
      i18n: {
        default_locale: "en",
        locales: ["en", "es", "fr", "zh-Hant"],
        detect: ["cookie:wl_locale", "accept-language"],
      },
    });

    assert.deepEqual(normalized.spec.i18n, {
      defaultLocale: "en",
      locales: ["en", "es", "fr", "zh-Hant"],
      detect: ["cookie:wl_locale", "accept-language"],
    });
  });

  it("preserves i18n: null (clear-the-slice) through manifest normalization", async () => {
    const normalized = await normalizeDeployManifest({
      project_id: "prj_manifest",
      i18n: null,
    });
    assert.equal(normalized.spec.i18n, null);
  });

  it("accepts SDK-native camelCase i18n fields for typed config compatibility", async () => {
    const normalized = await normalizeDeployManifest({
      project_id: "prj_manifest",
      i18n: {
        defaultLocale: "en",
        locales: ["en"],
      } as unknown as Parameters<typeof normalizeDeployManifest>[0]["i18n"],
    });

    assert.deepEqual(normalized.spec.i18n, {
      defaultLocale: "en",
      locales: ["en"],
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
              "index.html": { path: "index.html", content_type: "text/html" },
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

  it("loads local-dir site refs relative to the manifest directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-deploy-manifest-dir-test-"));
    try {
      const manifestPath = join(root, "app.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          project_id: "prj_file",
          site: {
            replace: {
              __source: "local-dir",
              path: "dist/run402/client",
            },
            public_paths: { mode: "implicit" },
          },
        }),
      );

      const normalized = await loadDeployManifest(manifestPath);

      assert.deepEqual(normalized.spec.site, {
        replace: {
          __source: "local-dir",
          path: join(root, "dist/run402/client"),
        },
        public_paths: { mode: "implicit" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads function source paths relative to the manifest directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-deploy-manifest-functions-test-"));
    try {
      const functionSource = "export default () => new Response('ok');\n";
      writeFileSync(join(root, "api.js"), functionSource);
      const manifestPath = join(root, "app.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          project_id: "prj_file",
          functions: {
            replace: {
              api: {
                runtime: "node22",
                source: { path: "api.js" },
              },
            },
          },
        }),
      );

      const normalized = await loadDeployManifest(manifestPath);

      assert.deepEqual(normalized.spec.functions?.replace?.api.source, {
        __source: "fs-file",
        path: join(root, "api.js"),
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

  it("passes function-level auth gates (requireAuth, requireRole) through manifest normalization", async () => {
    const normalized = await normalizeDeployManifest({
      project_id: "prj_manifest",
      functions: {
        replace: {
          authed: {
            runtime: "node22",
            source: { data: "export default async () => new Response('ok')" },
            require_auth: true,
          },
          admins: {
            runtime: "node22",
            source: { data: "export default async () => new Response('ok')" },
            require_role: {
              table: "members",
              id_column: "user_id",
              role_column: "role",
              allowed: ["admin"],
              cache_ttl: 30,
            },
          },
        },
        patch: {
          set: {
            cleared: {
              runtime: "node22",
              source: { data: "export default async () => new Response('ok')" },
              require_role: null,
            },
          },
        },
      },
    });

    const replaced = normalized.spec.functions?.replace;
    assert.equal(replaced?.authed.requireAuth, true);
    assert.deepEqual(replaced?.admins.requireRole, {
      table: "members",
      idColumn: "user_id",
      roleColumn: "role",
      allowed: ["admin"],
      cacheTtl: 30,
    });
    assert.equal(normalized.spec.functions?.patch?.set?.cleared.requireRole, null);
  });

  it("passes function capabilities through manifest normalization", async () => {
    const normalized = await normalizeDeployManifest({
      project_id: "prj_manifest",
      functions: {
        replace: {
          ssr: {
            runtime: "node22",
            class: "ssr",
            capabilities: ["astro.ssr.v1"],
            source: { data: "export default async () => new Response('ok')" },
          },
        },
      },
    });

    const ssr = normalized.spec.functions?.replace?.ssr;
    assert.equal(ssr?.class, "ssr");
    assert.deepEqual(ssr?.capabilities, ["astro.ssr.v1"]);
  });
});
