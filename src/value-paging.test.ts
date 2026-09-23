import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fitsInline, pageableItems, pageValue } from "./value-paging.js";

describe("value paging", () => {
  it("pages an array by element", () => {
    assert.deepEqual(pageableItems([1, 2]), { path: "$", items: [1, 2] });
  });

  it("pages an object by its largest top-level array and keeps the rest whole", () => {
    const paged = pageableItems({ row_count: 2, fields: [{ name: "id" }], rows: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    assert.equal(paged.path, "$.rows");
    assert.deepEqual(paged.rest, { row_count: 2, fields: [{ name: "id" }] });
    assert.equal(paged.items.length, 3);
  });

  it("pages an object without arrays by entry and a string by line", () => {
    assert.deepEqual(pageableItems({ a: 1 }), { path: "$entries", items: [{ key: "a", value: 1 }] });
    assert.deepEqual(pageableItems("x\ny"), { path: "$lines", items: ["x", "y"] });
  });

  it("windows whole items within the budget, and at least one", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, a: 1, b: 2 }));
    assert.equal(fitsInline(rows), false);
    const paged = pageValue(rows);
    assert.ok(paged.window.length > 0 && paged.window.length < 100);
    assert.ok(fitsInline(paged.window), "the window itself fits the budget");
    assert.deepEqual(paged.window[0], rows[0]);
    const huge = [{ text: "x\n".repeat(1000).split("\n") }];
    assert.equal(pageValue(huge).window.length, 1, "one oversized item still shows");
  });
});

describe("type stripping", () => {
  it("prints no ExperimentalWarning on stderr", () => {
    const root = join(import.meta.dirname, "..");
    const child = spawnSync(process.execPath, [
      "--import", "tsx",
      "-e", "import('./src/sandbox.ts').then(async (m) => { const r = await m.runInSandbox({ code: 'const a: number = 1; a', timeoutMs: 5000, extensions: [] }); process.stdout.write(String(r.value_json)); })",
    ], { cwd: root, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "1");
    assert.ok(!/ExperimentalWarning/.test(child.stderr), `stderr: ${child.stderr}`);
  });
});
