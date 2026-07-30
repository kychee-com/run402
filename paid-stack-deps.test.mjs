/**
 * paid-stack-deps.test.mjs — every PUBLISHED APPLICATION must SHIP the
 * paid-request stack. Not just the CLI.
 *
 * `@run402/sdk` declares the x402/viem/mpp packages as OPTIONAL peer
 * dependencies, which is right for a library: a consumer who never makes a
 * paid request should not have to install a signing stack. An application is
 * different. It is the thing our own quickstart tells a cold agent to run, and
 * `npx` installs a package's `dependencies` and nothing else.
 *
 * THIS HAS NOW BROKEN TWICE, in two different packages, the same way:
 *
 *   1. `@x402/extensions` was an SDK optional peer missing from the CLI's
 *      dependencies, so every cold `npx -y run402` install could not pay at
 *      all. The failure surfaced as PAYMENT_WALLET_UNFUNDED pointing at
 *      `run402 init` — for a wallet the faucet had just funded — so an
 *      unattended agent looped between "funded" and "unfunded" and gave up.
 *
 *   2. `@x402/evm`, `@x402/fetch` and `viem` were in `run402-mcp`'s
 *      **devDependencies** (and `mppx` absent entirely), so `npx run402-mcp` —
 *      the install line in the official MCP registry entry, the README,
 *      llms-mcp.txt and our own launch post — returned the raw 402 challenge
 *      and never paid. Found 2026-07-30 by cold-walking the buyer profile.
 *
 * Case 2 is the instructive one, and it is why this file replaces the
 * CLI-only gate rather than sitting beside it. A devDependency is present
 * exactly where the tests run and absent exactly where users install, so the
 * paid path passed every test in CI while being unusable by every consumer.
 * "Works for us" is not "works when installed" — and the previous gate, whose
 * docstring already described case 1, was pointed at only one of the two
 * applications it needed to cover.
 *
 * Gate the drift, not the symptom: whatever the SDK may load, every published
 * application ships — as a real dependency.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

const sdkPkg = readJson("sdk/package.json");

/**
 * Every package in this repo that a user installs and RUNS. Both are published
 * applications with a `bin`, both are advertised via `npx`, and both load the
 * SDK's paid stack at runtime. Add any future runnable package here.
 */
const APPS = [
  { label: "run402 (CLI)", path: "cli/package.json" },
  { label: "run402-mcp (MCP server)", path: "package.json" },
];

const optionalPeers = Object.entries(sdkPkg.peerDependenciesMeta ?? {})
  .filter(([, meta]) => meta?.optional)
  .map(([name]) => name)
  .sort();

describe("published applications ship the SDK's optional paid-request peers", () => {
  it("the SDK still declares optional peers (else this gate is silently dead)", () => {
    assert.ok(
      optionalPeers.length > 0,
      "expected the SDK to declare optional peers — if this list emptied, every assertion below passes vacuously",
    );
  });

  for (const app of APPS) {
    const pkg = readJson(app.path);

    it(`${app.label} declares every optional SDK peer as a real dependency`, () => {
      const shipped = Object.keys(pkg.dependencies ?? {});
      const missing = optionalPeers.filter((p) => !shipped.includes(p));

      assert.deepEqual(
        missing,
        [],
        `${app.path} must depend on every optional SDK peer so a cold ` +
          `\`npx -y ${pkg.name}\` can pay. Missing: ${missing.join(", ")}`,
      );
    });

    it(`${app.label} does not hide a paid-stack peer in devDependencies`, () => {
      // The exact shape of the run402-mcp break: present for CI, absent for
      // consumers. A dev-only declaration is WORSE than a missing one, because
      // it makes the whole paid path pass its own tests.
      const devOnly = optionalPeers.filter(
        (p) => (pkg.devDependencies ?? {})[p] && !(pkg.dependencies ?? {})[p],
      );
      assert.deepEqual(
        devOnly,
        [],
        `${app.path} lists paid-stack package(s) in devDependencies only, so tests can ` +
          `load them but installed users cannot: ${devOnly.join(", ")}. Move them to dependencies.`,
      );
    });

    it(`${app.label} does not declare a lower floor than the SDK requires`, () => {
      // A range the SDK would reject at runtime is drift too — it just fails
      // later, and only for whoever happens to resolve the older version.
      const offenders = [];
      for (const [name, sdkRange] of Object.entries(sdkPkg.peerDependencies ?? {})) {
        const appRange = pkg.dependencies?.[name];
        if (!appRange) continue;
        const floor = (r) => String(r).replace(/^[^0-9]*/, "");
        const cmp = (a, b) => {
          const pa = floor(a).split(".").map(Number);
          const pb = floor(b).split(".").map(Number);
          for (let i = 0; i < 3; i++) {
            if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
          }
          return 0;
        };
        if (cmp(appRange, sdkRange) < 0) offenders.push(`${name}: ${pkg.name} ${appRange} < sdk ${sdkRange}`);
      }
      assert.deepEqual(offenders, [], `${app.path} dependency floors below the SDK's peer requirement: ${offenders.join("; ")}`);
    });
  }
});
