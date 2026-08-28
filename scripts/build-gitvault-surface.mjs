#!/usr/bin/env node
/**
 * build-gitvault-surface.mjs — generates `cli/gitvault-surface.json` from
 * the single source `sync.test.ts` already enforces for the CLI surface
 * (openspec/changes/gitvault-page-truth-gate, design D1).
 *
 * The surface file is what run402-private's page-truth gate reads after
 * resolving the PUBLISHED `run402` package: the live `repos` family verbs,
 * every retired `gitvault <verb>` spelling (mechanically read off
 * `RESERVED_SUBCOMMANDS`, never hand-listed), and the capability ledger
 * beside `command-manifest.mjs`. Shipped inside the `run402` package
 * (`cli/package.json`'s `files`) so any consumer resolves it by installing
 * the CLI — no new endpoint, no new registry.
 *
 * Usage:
 *   node scripts/build-gitvault-surface.mjs          # regenerate the file
 *   node scripts/build-gitvault-surface.mjs --check   # CI: fail if stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMMAND_MANIFEST, RESERVED_SUBCOMMANDS } from "../cli/lib/command-manifest.mjs";
import { GITVAULT_CAPABILITIES } from "../cli/lib/gitvault-capabilities.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PACKAGE_JSON = join(ROOT, "cli", "package.json");
export const OUT_PATH = join(ROOT, "cli", "gitvault-surface.json");

/**
 * Pure builder: derives the surface object + its canonical serialized bytes
 * from `command-manifest.mjs` + `gitvault-capabilities.mjs` + the CLI
 * package version. No filesystem writes.
 */
export function buildGitvaultSurface() {
  const pkg = JSON.parse(readFileSync(CLI_PACKAGE_JSON, "utf-8"));

  // Every `repos <verb...>` entry in the command manifest — `repos` is
  // GitVault's live CLI surface (repo-surface-consolidation). Read
  // mechanically off COMMAND_MANIFEST, never hand-listed.
  const verbs = COMMAND_MANIFEST.filter((entry) => entry.path[0] === "repos").map((entry) =>
    entry.path.join(" "),
  );

  // Every retired `gitvault <verb>` spelling, mechanically read off
  // RESERVED_SUBCOMMANDS — the same single source sync.test.ts already
  // enforces for the CLI surface. `successor` carries the tombstone's own
  // description text (names the `repos`/git successor, or explains why a
  // spelling has none).
  const retired_spellings = Object.entries(RESERVED_SUBCOMMANDS)
    .filter(([key]) => key.startsWith("gitvault:"))
    .map(([key, successor]) => ({
      spelling: key.replace("gitvault:", "gitvault "),
      successor,
    }));

  const surface = {
    surface_version: pkg.version,
    verbs,
    retired_spellings,
    capabilities: { ...GITVAULT_CAPABILITIES },
  };

  const bytes = JSON.stringify(surface, null, 2) + "\n";
  return { surface, bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  const { bytes } = buildGitvaultSurface();
  let current = "";
  try {
    current = readFileSync(OUT_PATH, "utf-8");
  } catch {
    /* missing → treated as stale */
  }
  if (check) {
    if (current !== bytes) {
      console.error(
        "cli/gitvault-surface.json is stale — run: node scripts/build-gitvault-surface.mjs",
      );
      process.exit(1);
    }
    console.log("cli/gitvault-surface.json is up to date");
  } else if (current !== bytes) {
    writeFileSync(OUT_PATH, bytes);
    console.log("regenerated cli/gitvault-surface.json");
  } else {
    console.log("unchanged   cli/gitvault-surface.json");
  }
}
