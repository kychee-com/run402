import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverRehearseManifest } from "./deploy-v2.mjs";

describe("deploy rehearse — manifest discovery (the way up does it)", () => {
  it("prefers run402.json, then run402.deploy.json, then app.json, then executable configs", () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-rehearse-discover-"));
    try {
      assert.equal(discoverRehearseManifest(dir), null);
      writeFileSync(join(dir, "run402.deploy.ts"), "export default {}");
      assert.equal(discoverRehearseManifest(dir), join(dir, "run402.deploy.ts"));
      writeFileSync(join(dir, "app.json"), "{}");
      assert.equal(discoverRehearseManifest(dir), join(dir, "app.json"));
      writeFileSync(join(dir, "run402.deploy.json"), "{}");
      assert.equal(discoverRehearseManifest(dir), join(dir, "run402.deploy.json"));
      writeFileSync(join(dir, "run402.json"), "{}");
      assert.equal(discoverRehearseManifest(dir), join(dir, "run402.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
