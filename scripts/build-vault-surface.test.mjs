import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildVaultSurface, OUT_PATH } from "./build-vault-surface.mjs";

describe("cli/vault-surface.json", () => {
  it("is byte-identical to what the manifest + capability ledger generate (staleness gate)", () => {
    const { bytes } = buildVaultSurface();
    const committed = readFileSync(OUT_PATH, "utf-8");
    assert.equal(
      committed,
      bytes,
      "cli/vault-surface.json is stale — run: node scripts/build-vault-surface.mjs",
    );
  });

  it("builds byte-identical output across two runs (deterministic)", () => {
    const first = buildVaultSurface();
    const second = buildVaultSurface();
    assert.equal(first.bytes, second.bytes);
  });

  it("derives verbs from the repos family of COMMAND_MANIFEST, mechanically", () => {
    const { surface } = buildVaultSurface();
    assert.ok(Array.isArray(surface.verbs));
    assert.ok(surface.verbs.length > 0);
    for (const verb of surface.verbs) {
      assert.match(verb, /^repos( .+)?$/);
    }
    assert.ok(surface.verbs.includes("repos create"));
    assert.ok(surface.verbs.includes("repos access repair"));
    assert.ok(surface.verbs.includes("repos handoff"));
    assert.ok(surface.verbs.includes("repos resume"));
  });

  it("names no retired spellings — a removed verb is deleted, never tombstoned", () => {
    const { surface } = buildVaultSurface();
    assert.deepEqual(surface.retired_spellings, []);
  });

  it("carries the CLI package version as surface_version", () => {
    const { surface } = buildVaultSurface();
    assert.match(surface.surface_version, /^\d+\.\d+\.\d+/);
  });

  it("carries the full capability ledger", () => {
    const { surface } = buildVaultSurface();
    assert.deepEqual(Object.keys(surface.capabilities).sort(), [
      "allocation",
      "byo_live",
      "capture_dirty_default",
      "handoff_dirty_default",
      "handoff_live",
      "human_envelope_add_live",
      "invite_live",
      "join_live",
      "mirror_live",
      "recover_live",
      "revocation_live",
    ]);
  });
});
