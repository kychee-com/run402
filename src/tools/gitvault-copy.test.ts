/**
 * The gitvault copy gate.
 *
 * gitvault's claims are NORMATIVE, not descriptive: the approved sentences come
 * from the protocol's own claims line (docs/strategy/products/gitvault/
 * threat-model.md §1) and the banned ones from its banned-copy list (§8). Each
 * banned phrase is banned because it OVERCLAIMS — it promises a property the
 * system does not have — so a paraphrase that reads better is a regression, not
 * an edit. Copy may shorten only by omitting a whole clause, never by rewording
 * one.
 *
 * This test pins both directions against the shipped surface: the tool
 * descriptions in src/index.ts (what an agent reads before it calls anything)
 * and the tool module itself.
 *
 * Run: node --test --import tsx src/tools/gitvault-copy.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const INDEX_SRC = read("../index.ts");
const GITVAULT_SRC = read("./gitvault.ts");
const EXPAND_SRC = read("./expand-result.ts");
const STORE_SRC = read("../result-store.ts");

const GITVAULT_TOOLS = ["get_gitvault_status", "list_gitvault_heads", "verify_gitvault"] as const;

/**
 * Pull the description literal a `server.tool(...)` registration carries. It is
 * the second argument and always a plain double-quoted string in this file, so
 * the literal round-trips through JSON.parse.
 */
function toolDescription(name: string): string {
  const anchor = `server.tool(\n  "${name}",\n  `;
  const at = INDEX_SRC.indexOf(anchor);
  assert.notEqual(at, -1, `server.tool("${name}", ...) is not registered in src/index.ts`);
  const from = at + anchor.length;
  assert.equal(INDEX_SRC[from], '"', `${name}'s description must be a plain double-quoted string literal`);
  let i = from + 1;
  while (i < INDEX_SRC.length) {
    if (INDEX_SRC[i] === "\\") {
      i += 2;
      continue;
    }
    if (INDEX_SRC[i] === '"') break;
    i += 1;
  }
  return JSON.parse(INDEX_SRC.slice(from, i + 1)) as string;
}

// ─── The approved vocabulary (verbatim; do not retype these by hand) ─────────

/** The three normative claims. This is the ENTIRE approved claims vocabulary. */
const CLAIM_CONFIDENTIALITY =
  "Run402 cannot decrypt your gitvault or repository history. Deployment artifacts remain a disclosed plaintext custody boundary.";
const CLAIM_ACTIVATION = "Activation requires vault admission by default; an explicit, audited override can bypass it.";
const CLAIM_RETENTION =
  "Retention is an operational promise of the platform, not a cryptographic guarantee against it (the host controls timestamps and bytes).";

/** The V0-A terminal-loss sentence — doctor and status state it verbatim. */
const TERMINAL_LOSS = "whole-machine or whole-keystore loss is terminal for vault history until human envelopes ship";

/** Durability is keystore-qualified. Stating the first half without the second is banned. */
const KEYSTORE_QUALIFIED_DURABILITY =
  "The vault protects source history from host-side loss while a principal keystore survives.";

/** The only permitted scoped confidentiality sentence (D57 / D168). */
const SCOPED_CONFIDENTIALITY =
  "source payload and repository-history content are ciphertext-only; the substrate retains only enumerated plaintext metadata and holds zero vault keys";

/** Verbatim from the protocol's banned-copy list, plus the two forbidden unqualified patterns (D168). */
const BANNED_PHRASES = [
  "cannot read your source",
  "no release ever activates unvaulted",
  "stops the bleeding",
  "stores ciphertext only",
  "storage with receipts",
] as const;

const DESCRIPTIONS = Object.fromEntries(GITVAULT_TOOLS.map((t) => [t, toolDescription(t)])) as Record<
  (typeof GITVAULT_TOOLS)[number],
  string
>;

/** Everything an agent or a reader can see of this feature's copy. */
const CORPUS = [GITVAULT_SRC, EXPAND_SRC, STORE_SRC, toolDescription("expand_result"), ...Object.values(DESCRIPTIONS)].join(
  "\n",
);

describe("gitvault copy — banned phrases", () => {
  for (const phrase of BANNED_PHRASES) {
    it(`never says "${phrase}"`, () => {
      assert.equal(
        CORPUS.toLowerCase().includes(phrase.toLowerCase()),
        false,
        `"${phrase}" is on the protocol's banned-copy list because it overclaims. Use the approved sentence instead — do not paraphrase it.`,
      );
    });
  }
});

describe("gitvault copy — the approved claims, byte-for-byte", () => {
  it("get_gitvault_status states the confidentiality claim", () => {
    assert.ok(
      DESCRIPTIONS.get_gitvault_status.includes(CLAIM_CONFIDENTIALITY),
      "the confidentiality claim must appear verbatim, including the deployment-artifact custody sentence that scopes it",
    );
  });

  it("get_gitvault_status states the activation claim", () => {
    assert.ok(
      DESCRIPTIONS.get_gitvault_status.includes(CLAIM_ACTIVATION),
      "the tool reports gitvault_policy and pending overrides, so it must say that an audited override exists",
    );
  });

  it("get_gitvault_status states the terminal-loss sentence", () => {
    assert.ok(
      DESCRIPTIONS.get_gitvault_status.includes(TERMINAL_LOSS),
      "the terminal-loss sentence is a reviewed product commitment and is stated verbatim, not summarised",
    );
  });

  it("verify_gitvault states the retention claim", () => {
    assert.ok(
      DESCRIPTIONS.verify_gitvault.includes(CLAIM_RETENTION),
      "verification proves the chain; retention is the thing it cannot prove, so the claim belongs here",
    );
  });

  it("the tool module carries the keystore-qualified durability sentence", () => {
    assert.ok(
      GITVAULT_SRC.includes(KEYSTORE_QUALIFIED_DURABILITY),
      "durability copy without the keystore qualifier is banned; this is the qualified form",
    );
  });

  it("the tool module carries the scoped confidentiality sentence", () => {
    assert.ok(
      GITVAULT_SRC.includes(SCOPED_CONFIDENTIALITY),
      "the scoped sentence is the ONLY permitted form of the ciphertext claim",
    );
  });
});

describe("gitvault copy — the read-only boundary is stated, not implied", () => {
  it("no mutating gitvault verb is registered as a tool", () => {
    for (const forbidden of [
      "gitvault_push",
      "gitvault_init",
      "gitvault_compact",
      "gitvault_prune",
      "gitvault_deploy",
      "set_gitvault_policy",
    ]) {
      assert.equal(
        INDEX_SRC.includes(`server.tool(\n  "${forbidden}"`),
        false,
        `${forbidden} must stay CLI-only — see the header of src/tools/gitvault.ts for the reasoning`,
      );
    }
  });

  it("the module explains WHY each mutation is excluded", () => {
    // A bare "read-only by design" comment rots; the reasons are what a future
    // reader needs in order to decide whether an exclusion still holds.
    for (const verb of ["push", "init", "compact", "prune", "deploy", "setPolicy"]) {
      assert.ok(GITVAULT_SRC.includes(verb), `the header must name ${verb} among the excluded mutations`);
    }
    assert.ok(GITVAULT_SRC.includes("holder_token"), "the compact exclusion turns on the once-returned lease token");
    assert.ok(GITVAULT_SRC.includes("recovery receipt"), "the init exclusion turns on the one-shot recovery receipt");
  });
});
