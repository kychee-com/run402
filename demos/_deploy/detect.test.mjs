import { test } from "node:test";
import assert from "node:assert/strict";
import { detectChangedApps, deployableAppNames } from "./detect.mjs";

// A tiny in-memory registry shaped like loadRegistry()'s output.
function entry(name, { project_id = `prj_${name}`, valid = true, cd, relDir } = {}) {
  const config = { name, project_id };
  if (cd !== undefined) config.cd = cd;
  return { name, relDir: relDir || `demos/${name}`, config, valid };
}

const REG = [
  entry("test-video"),
  entry("passkeys"),
  entry("cosmicforge", { project_id: "<unset>" }), // registered but not provisioned
  entry("evilme", { valid: false }), // invalid app.json
  entry("paused", { cd: false }), // explicit CD opt-out
];

test("deployableAppNames keeps only valid, provisioned, cd!==false demos", () => {
  assert.deepEqual(deployableAppNames(REG).sort(), ["passkeys", "test-video"]);
});

test("a per-demo change selects only that demo", () => {
  const r = detectChangedApps(["demos/passkeys/public/index.html"], REG);
  assert.deepEqual(r, { apps: ["passkeys"], reason: "per-app" });
});

test("changes touching two demos select both, sorted", () => {
  const r = detectChangedApps(
    ["demos/test-video/app.json", "demos/passkeys/public/index.html"],
    REG,
  );
  assert.deepEqual(r, { apps: ["passkeys", "test-video"], reason: "per-app" });
});

test("a shared-tooling change redeploys all eligible demos", () => {
  for (const p of ["demos/_deploy/apply.mjs", ".github/workflows/deploy-demos.yml"]) {
    const r = detectChangedApps([p], REG);
    assert.equal(r.reason, "shared-tooling", p);
    assert.deepEqual(r.apps, ["passkeys", "test-video"], p);
  }
});

test("changes to unprovisioned / invalid / cd:false demos are no-ops", () => {
  const r = detectChangedApps(
    ["demos/cosmicforge/index.html", "demos/evilme/function.js", "demos/paused/app.json"],
    REG,
  );
  assert.deepEqual(r, { apps: [], reason: "none" });
});

test("paths outside demos/ are ignored", () => {
  const r = detectChangedApps(["sdk/src/index.ts", "README.md"], REG);
  assert.deepEqual(r, { apps: [], reason: "none" });
});

test("normalizes ./ prefixes and backslashes", () => {
  const r = detectChangedApps(["./demos/passkeys/x", "demos\\test-video\\app.json"], REG);
  assert.deepEqual(r.apps, ["passkeys", "test-video"]);
});

test("a longer sibling name does not match a shorter demo's prefix", () => {
  // "demos/test-video-pro/..." must NOT select "test-video".
  const r = detectChangedApps(["demos/test-video-pro/index.html"], REG);
  assert.deepEqual(r, { apps: [], reason: "none" });
});
