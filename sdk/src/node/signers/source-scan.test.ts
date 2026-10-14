/**
 * One resolver, enforced (spec `wallet-signers`, design D2): signing goes
 * through `signers/index.ts`, so a signer-backed wallet works wherever a
 * key-backed one does. This fails when production code outside the files
 * below builds an account from a private key or reads `.privateKey`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SCANNED = ["core/src", "sdk/src", "cli/lib", "src"];

/** Where a private key may legitimately be touched, and why. */
const ALLOWED: Record<string, string> = {
  "sdk/src/node/signers/index.ts": "the resolver itself",
  "core/src/wallet.ts": "reads and validates wallet.json",
  "core/src/wallet-auth.ts": "synchronous SIWX for a key-backed wallet (a signer-backed one goes through the resolver)",
  "sdk/src/node/wallets.ts": "key generation (wallets.create) and key import",
  "sdk/src/node/init.ts": "key generation (run402 init)",
  "cli/lib/cold-start.mjs": "key generation (CLI cold start)",
  "sdk/src/node/doctor.ts": "removes the key from diagnostics",
};

const PATTERNS = [/\bprivateKeyToAccount\(/, /\.privateKey\b/];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.endsWith("-dist")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(ts|mjs|js)$/.test(name) && !/\.(test|integ)\.(ts|mjs)$/.test(name)) yield path;
  }
}

describe("signing goes through the resolver", () => {
  it("no production file outside the allowlist builds an account from a key or reads .privateKey", () => {
    const offenders: string[] = [];
    for (const top of SCANNED) {
      for (const file of files(join(ROOT, top))) {
        const rel = relative(ROOT, file);
        if (ALLOWED[rel]) continue;
        readFileSync(file, "utf8").split("\n").forEach((line, i) => {
          if (PATTERNS.some((p) => p.test(line))) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    assert.deepEqual(offenders, [], "sign through resolveWalletAccount / personalMessageSignerFor instead");
  });
});
