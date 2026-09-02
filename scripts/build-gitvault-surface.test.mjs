import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildGitvaultSurface, OUT_PATH } from "./build-gitvault-surface.mjs";

describe("cli/gitvault-surface.json", () => {
  it("is byte-identical to what the manifest + capability ledger generate (staleness gate)", () => {
    const { bytes } = buildGitvaultSurface();
    const committed = readFileSync(OUT_PATH, "utf-8");
    assert.equal(
      committed,
      bytes,
      "cli/gitvault-surface.json is stale — run: node scripts/build-gitvault-surface.mjs",
    );
  });

  it("builds byte-identical output across two runs (deterministic)", () => {
    const first = buildGitvaultSurface();
    const second = buildGitvaultSurface();
    assert.equal(first.bytes, second.bytes);
  });

  it("derives verbs from the repos family of COMMAND_MANIFEST, mechanically", () => {
    const { surface } = buildGitvaultSurface();
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

  it("derives retired_spellings from RESERVED_SUBCOMMANDS' gitvault entries, mechanically", () => {
    const { surface } = buildGitvaultSurface();
    assert.ok(Array.isArray(surface.retired_spellings));
    const spellings = surface.retired_spellings.map((r) => r.spelling);
    assert.ok(spellings.includes("gitvault status"));
    assert.ok(spellings.includes("gitvault push"));
    for (const entry of surface.retired_spellings) {
      assert.match(entry.spelling, /^gitvault /);
      assert.equal(typeof entry.successor, "string");
      assert.ok(entry.successor.length > 0);
    }
  });

  it("carries the CLI package version as surface_version", () => {
    const { surface } = buildGitvaultSurface();
    assert.match(surface.surface_version, /^\d+\.\d+\.\d+/);
  });

  it("carries the full capability ledger", () => {
    const { surface } = buildGitvaultSurface();
    assert.deepEqual(Object.keys(surface.capabilities).sort(), [
      "allocation",
      "byo_live",
      "handoff_dirty_default",
      "handoff_live",
      "human_envelope_add_live",
      "mirror_live",
      "recover_live",
      "remote_schemes",
      "revocation_live",
      "snapshot_dirty_default",
    ]);
  });
});
