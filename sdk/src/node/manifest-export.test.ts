import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeDeployManifest, loadDeployManifest } from "./deploy-manifest.js";
import { serializeDeployManifest } from "./manifest-export.js";

test("authoring export reloads file references, bytes, canonical config and projectless intent", async () => {
  const root = mkdtempSync(join(tmpdir(), "run402-export-"));
  try {
    writeFileSync(join(root, "api.js"), "export default () => new Response('ok');");
    writeFileSync(join(root, "001.sql"), "create table demo (id int);");
    const raw = { database: { migrations: [{ name: "demo", sql_path: "001.sql" }] }, functions: { replace: { api: { source: { path: "api.js" }, config: { timeoutSeconds: 5, memoryMb: 128 } } } }, site: { replace: { "index.html": { data: "hello", content_type: "text/html" }, "bytes.bin": { data: "AAEC", encoding: "base64" } } } };
    const before = await normalizeDeployManifest(raw as any, { baseDir: root, defaultProject: "internal" });
    const exported = serializeDeployManifest(before, root);
    assert.equal(exported.project_id, undefined);
    assert.equal(JSON.stringify(exported).includes("__source"), false);
    assert.deepEqual((exported.functions as any).replace.api.config, { timeout_seconds: 5, memory_mb: 128 });
    assert.deepEqual((exported.functions as any).replace.api.source, { path: "api.js" });
    assert.equal((exported.database as any).migrations[0].sql_path, "001.sql");
    const after = await normalizeDeployManifest(exported as any, { baseDir: root, defaultProject: "internal" });
    assert.deepEqual(after.spec, before.spec);
    assert.equal(serializeDeployManifest(before, root, "prj_selected").project_id, "prj_selected");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("supported typed data configs export once without serializing runtime or environment values", async () => {
  const root = mkdtempSync(join(tmpdir(), "run402-export-typed-"));
  try {
    const path = join(root, "run402.deploy.mjs");
    writeFileSync(path, 'export default {site:{replace:{"index.html":{data:"hello"}}}};');
    const loaded = await loadDeployManifest(path, { defaultProject: "internal" });
    assert.deepEqual(serializeDeployManifest(loaded, root), { site: { replace: { "index.html": "hello" } } });
    loaded.config = { env_accessed: ["SECRET"] };
    assert.throws(() => serializeDeployManifest(loaded, root), { code: "MANIFEST_EXPORT_UNSUPPORTED" });
    delete loaded.config;
    loaded.spec.site = { replace: { "index.html": new ReadableStream() } };
    assert.throws(() => serializeDeployManifest(loaded, root), (err: any) => err.code === "MANIFEST_EXPORT_UNSUPPORTED" && err.details.field_paths[0] === "site.replace.index.html");
    loaded.spec.secrets = { set: { TOKEN: "never-output-this" } } as any;
    assert.throws(() => serializeDeployManifest(loaded, root), (err: any) => err.code === "MANIFEST_EXPORT_UNSUPPORTED" && !JSON.stringify(err).includes("never-output-this"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
