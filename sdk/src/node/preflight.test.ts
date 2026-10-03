import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeLocalPreflight } from "./preflight.js";

const target = { project_id: "prj_1", project_name: null, source: "explicit" as const };

function withAppRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "run402-preflight-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("--check summarizes the site inventory by content type, inferring from the path when no type is given", () => {
  withAppRoot((root) => {
    const preflight = describeLocalPreflight({
      appRoot: root,
      manifestPath: join(root, "run402.json"),
      target,
      spec: {
        site: {
          replace: {
            "index.html": "<!doctype html>",
            "about.html": { data: "<h1>About</h1>", contentType: "text/html; charset=utf-8" },
            "sigil.webp": { __source: "fs-file", path: join(root, "sigil.webp") },
            "app.css": { sha256: "a".repeat(64), size: 12 },
            "font.woff2": { sha256: "b".repeat(64), size: 34, contentType: "font/woff2" },
          },
        },
      },
    });
    assert.deepEqual(preflight.summary.site, {
      paths: 5,
      by_content_type: {
        "font/woff2": 1,
        "image/webp": 1,
        "text/css; charset=utf-8": 1,
        "text/html; charset=utf-8": 2,
      },
    });
  });
});

test("--check counts a site.patch.put slice the same way and reports zero paths for a site-less spec", () => {
  withAppRoot((root) => {
    const patched = describeLocalPreflight({
      appRoot: root,
      manifestPath: null,
      target,
      spec: { site: { patch: { put: { "logo.png": { sha256: "c".repeat(64), size: 1 } } } } },
    });
    assert.deepEqual(patched.summary.site, { paths: 1, by_content_type: { "image/png": 1 } });

    const none = describeLocalPreflight({ appRoot: root, manifestPath: null, target, spec: { functions: { replace: {} } } });
    assert.deepEqual(none.summary.site, { paths: 0, by_content_type: {} });
  });
});

test("--check expands a local-dir site the way deploy does, instead of counting the marker's keys (run402#603)", () => {
  withAppRoot((root) => {
    const site = join(root, "site");
    mkdirSync(join(site, "icons"), { recursive: true });
    mkdirSync(join(site, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(site, "index.html"), "<!doctype html>");
    writeFileSync(join(site, "app.js"), "export {};");
    writeFileSync(join(site, "app.css"), "body{}");
    writeFileSync(join(site, "icons", "icon-192.png"), new Uint8Array([137, 80, 78, 71]));
    writeFileSync(join(site, ".env"), "SECRET=1");
    writeFileSync(join(site, "node_modules", "pkg", "index.js"), "module.exports = 1;");

    for (const slice of [
      { replace: { __source: "local-dir" as const, path: site } },
      { patch: { put: { __source: "local-dir" as const, path: site, prefix: "static" } } },
    ]) {
      const preflight = describeLocalPreflight({ appRoot: root, manifestPath: join(root, "run402.json"), target, spec: { site: slice } as never });
      assert.deepEqual(preflight.summary.site, {
        paths: 4,
        by_content_type: {
          "image/png": 1,
          "text/css; charset=utf-8": 1,
          "text/html; charset=utf-8": 1,
          "text/javascript; charset=utf-8": 1,
        },
      });
    }
  });
});

test("--check types a .webmanifest as application/manifest+json, the type it ships with (run402#604)", () => {
  withAppRoot((root) => {
    const preflight = describeLocalPreflight({
      appRoot: root,
      manifestPath: null,
      target,
      spec: { site: { replace: { "manifest.webmanifest": { sha256: "d".repeat(64), size: 2 } } } },
    });
    assert.deepEqual(preflight.summary.site, { paths: 1, by_content_type: { "application/manifest+json": 1 } });
  });
});
