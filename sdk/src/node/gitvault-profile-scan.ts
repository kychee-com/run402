/**
 * gitvault — cross-profile repo-key scan.
 *
 * A keystore-miss refusal (`KEYSTORE_MISSING`, `GITVAULT_REPO_STATE_MISSING`,
 * or the non-holder half of a `VAULT_CREATION_CONFLICT` reconciliation
 * attempt — see `gitvault-creation-journal.ts`) is read against the ACTIVE
 * wallet profile only. When the repo's key actually lives under a DIFFERENT
 * local profile — the common dogfood shape: the active wallet changed
 * outside a bound workspace, or `--wallet`/`RUN402_WALLET` was never set for
 * this shell — the refusal named a remedy ("restore the keystore") that did
 * not apply, and said nothing about the faster one that did.
 *
 * This module is a PURELY LOCAL, READ-ONLY directory + filename scan: it
 * lists `profiles/` and checks whether `repos/<repo_id>.json` EXISTS under
 * each one. It never opens, parses, or reads the CONTENTS of any file it
 * finds — a profile "holds" the key when the filename is present, nothing
 * more — so it can never leak key material into an error message.
 *
 * Shared by every keystore-miss enrichment point (`gitvault-publication.ts`'s
 * `GitvaultVault.repoFile()`, and `gitvault-creation-journal.ts`'s
 * conflict-reconciliation non-holder path) so the hint text and the two
 * named selection mechanisms (`--wallet` / `RUN402_WALLET`) are written once.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { listProfileNames, profileDir } from "../../core-dist/profiles.js";
import { GITVAULT_SRC_RE } from "../namespaces/gitvault.crypto.js";

/**
 * Which local profiles hold a repo-key FILE for `repoId` — a directory
 * listing plus a filename check, nothing more. Built on `core/src/profiles.ts`'s
 * own `listProfileNames`/`profileDir` — the SAME "wallets on this machine"
 * enumeration `run402 wallets list` uses — rather than a second copy of that
 * logic. Never throws: an unreadable profiles directory, a permissions
 * error, or a malformed `repoId` all resolve to "found nothing" rather than
 * failing the refusal path this feeds into.
 */
export function findLocalProfilesHoldingGitvaultRepo(repoId: string, options: { excludeProfile?: string } = {}): string[] {
  if (!GITVAULT_SRC_RE.test(repoId)) return [];
  const found: string[] = [];
  for (const profile of listProfileNames()) {
    if (options.excludeProfile && profile === options.excludeProfile) continue;
    try {
      const repoPath = join(profileDir(profile), "gitvault", "repos", `${repoId}.json`);
      if (existsSync(repoPath)) found.push(profile);
    } catch {
      // treat as absent — this is a diagnostic hint, never a hard failure
    }
  }
  return found;
}

/**
 * Build the `next_actions` entries naming the profile(s) found and the two
 * selection mechanisms every keystore-miss refusal points at. `[]` when the
 * scan finds nothing local to point at — callers append this to whatever
 * refusal-specific remedies they already carry, never replacing them.
 */
export function crossProfileGitvaultHint(repoId: string, options: { excludeProfile?: string } = {}): { action: string }[] {
  const profiles = findLocalProfilesHoldingGitvaultRepo(repoId, options);
  if (profiles.length === 0) return [];
  const named = profiles.map((p) => `'${p}'`).join(", ");
  return [
    {
      action:
        `this repo's key exists under wallet ${named} on this machine — ` +
        `run with --wallet <name> or set RUN402_WALLET=<name> to select it`,
    },
  ];
}
