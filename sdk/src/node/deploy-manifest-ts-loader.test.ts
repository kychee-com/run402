/**
 * Which loader runs a TypeScript deploy config. The rest of the suite runs
 * under `--import tsx`, whose hooks would load every .ts file themselves, so
 * this one runs the BUILT SDK (`sdk/dist`, which `npm test` builds first) in
 * a plain child Node. Each config reports how it was imported: Node's own
 * loader keeps the SDK's `?run402_config=` cache-buster in `import.meta.url`,
 * tsx's `tsImport` does not.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIST = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/node/deploy-manifest.js")).href;
const REPORT = `export default { project_id: new URL(import.meta.url).search.includes("run402_config") ? "native" : "tsx" };\n`;
const NATIVE = typeof (process.features as { typescript?: unknown }).typescript === "string";

function loadedBy(files: Record<string, string>, pkg: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "run402-ts-loader-"));
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
    for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source);
    const script = `const { loadExecutableDeployConfig } = await import(${JSON.stringify(DIST)});
      const config = await loadExecutableDeployConfig(${JSON.stringify(join(root, "run402.deploy.ts"))});
      process.stdout.write(config.project_id);`;
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    return execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { env, encoding: "utf8" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("TypeScript deploy config loader", () => {
  it("loads an erasable-types config through Node's own type stripping", { skip: !NATIVE && "this Node has no type stripping" }, () => {
    assert.equal(loadedBy({ "run402.deploy.ts": `type Id = string;\nconst id: Id = "x";\nvoid id;\n${REPORT}` }, { type: "module" }), "native");
  });

  it("falls back to tsx for a config Node cannot strip", () => {
    assert.equal(loadedBy({ "run402.deploy.ts": `enum E { A = 1 }\nvoid E.A;\n${REPORT}` }, { type: "module" }), "tsx");
  });

  it("prefers tsx for a .ts config in a package without type: module", () => {
    assert.equal(loadedBy({ "run402.deploy.ts": REPORT }, { name: "typeless" }), "tsx");
  });
});
