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
    });

    assert.equal(normalized.spec.project, "prj_manifest");
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
});
