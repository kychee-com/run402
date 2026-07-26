/**
 * cli-paid-stack-deps.test.mjs — the CLI must SHIP the paid-request stack.
 *
 * `@run402/sdk` declares the x402/viem/mpp packages as OPTIONAL peer
 * dependencies, which is right for a library: a consumer who never makes a
 * paid request should not have to install a signing stack. The CLI is not a
 * library. It is the thing our own quickstart tells a cold agent to run
 * (`npx -y run402 init` / `up` / `pay`), so it must supply every peer the SDK
 * may load — `npx` installs a package's dependencies and nothing else.
 *
 * This drifted once and cost real conversions: `@x402/extensions` was in the
 * SDK's optional-peer set but missing from the CLI's dependencies, so every
 * cold `npx -y run402` install could not pay at all. Worse, the failure
 * surfaced as PAYMENT_WALLET_UNFUNDED pointing at `run402 init` — for a wallet
 * the faucet had just funded on an accepted challenge network — so an
 * unattended agent looped between "funded" and "unfunded" and gave up. The
 * free testnet paths kept working, which is why it survived: the break was
 * invisible until money was involved.
 *
 * Gate the drift, not the symptom: whatever the SDK may load, the CLI ships.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

const sdkPkg = readJson("sdk/package.json");
const cliPkg = readJson("cli/package.json");

describe("CLI ships the SDK's optional paid-request peers", () => {
  it("declares every optional peer dependency the SDK can load", () => {
    const optionalPeers = Object.entries(sdkPkg.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta?.optional)
      .map(([name]) => name)
      .sort();

    assert.ok(
      optionalPeers.length > 0,
      "expected the SDK to declare optional peers — if this list emptied, this gate is silently dead",
    );

    const shipped = Object.keys(cliPkg.dependencies ?? {});
    const missing = optionalPeers.filter((p) => !shipped.includes(p));

    assert.deepEqual(
      missing,
      [],
      `cli/package.json must depend on every optional SDK peer so a cold ` +
        `\`npx -y run402\` can pay. Missing: ${missing.join(", ")}`,
    );
  });

  it("does not declare a lower floor than the SDK requires", () => {
    // A range the SDK would reject at runtime is drift too — it just fails
    // later, and only for whoever happens to resolve the older version.
    const offenders = [];
    for (const [name, sdkRange] of Object.entries(sdkPkg.peerDependencies ?? {})) {
      const cliRange = cliPkg.dependencies?.[name];
      if (!cliRange) continue;
      const floor = (r) => String(r).replace(/^[^0-9]*/, "");
      const cmp = (a, b) => {
        const pa = floor(a).split(".").map(Number);
        const pb = floor(b).split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
        }
        return 0;
      };
      if (cmp(cliRange, sdkRange) < 0) offenders.push(`${name}: cli ${cliRange} < sdk ${sdkRange}`);
    }
    assert.deepEqual(offenders, [], `CLI dependency floors below the SDK's peer requirement: ${offenders.join("; ")}`);
  });
});
