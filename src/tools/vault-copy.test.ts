/**
 * The vault copy gate.
 *
 * vault's claims are NORMATIVE, not descriptive: the approved sentences come
 * from the protocol's own claims line (docs/kygit/threat-model.md §1 — the
 * vendored mirror of the private working draft) and the banned ones from its
 * banned-copy list (§8). Each
 * banned phrase is banned because it OVERCLAIMS — it promises a property the
 * system does not have — so a paraphrase that reads better is a regression, not
 * an edit. Copy may shorten only by omitting a whole clause, never by rewording
 * one.
 *
 * This test pins both directions against the shipped surface: the MCP
 * result-store copy an agent reads (the expand_result description and its
 * modules), and EVERY public doc surface that mentions the vault
 * (the CLI/SDK docs-site sources and their generated flat files, README.md,
 * SKILL.md, sdk/README.md). Docs are where this copy rots
 * fastest — nobody re-reads a reference section when the protocol changes, and a
 * broadened sentence reads like better writing.
 *
 * Run: node --test --import tsx src/tools/vault-copy.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const readSection = (section: string): string => {
  const dir = new URL('../../docs-site/src/content/docs/' + section + '/', import.meta.url);
  return readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(f => readFileSync(new URL(f, dir), 'utf8')).join('\n');
};

const INDEX_SRC = read("../index.ts");
const EXPAND_SRC = read("./expand-result.ts");
const STORE_SRC = read("../result-store.ts");

/**
 * Every public doc surface that talks about the vault. The generated flat files
 * are included alongside their docs-site sources on purpose: the generator is
 * the only thing keeping them equal, and this gate should fail if that ever
 * stops being true.
 */
const DOC_SURFACES = {
  "README.md": read("../../README.md"),
  "SKILL.md": read("../../SKILL.md"),
  "sdk/README.md": read("../../sdk/README.md"),
  "cli/llms-cli.txt": read("../../cli/llms-cli-full.txt"),
  "sdk/llms-sdk.txt": read("../../sdk/llms-sdk.txt"),
  "docs-site cli/reference.md": read("../../docs-site/src/content/docs/cli/repos.md"),
  "docs-site sdk/reference.md": readSection("sdk"),
  "openclaw/SKILL.md": read("../../openclaw/SKILL.md"),
  "documentation.md": read("../../documentation.md"),
  "maintenance-map.md": read("../../docs/quality/maintenance-map.md"),
  // repo-first-onramp (task 2.8 doc sweep): the vault-only track's new
  // surfaces. `cli/lib/repos.mjs` prints the SDK's own terminal-loss text
  // verbatim at runtime rather than hardcoding it, but its HELP string is
  // still user-facing copy about the vault and belongs under this gate.
  "cli/README.md": read("../../cli/README.md"),
  "cli/lib/repos.mjs": read("../../cli/lib/repos.mjs"),
  "cli/lib/vault-scaffold.mjs": read("../../cli/lib/vault-scaffold.mjs"),
  // llms.txt gained its first-ever vault mention in this change (task 2.8)
  // — a pitch-level bullet, so it belongs under the gate from day one.
  "llms.txt": read("../../llms.txt"),
  // kygit-invite: the second claim kind's own doc surfaces — `join`
  // restores a working tree exactly like `resume`, so the SAME
  // banned-phrase / machine-loss-qualifier discipline applies the moment
  // either mentions vault, and `read_room_messages`' `wait` parameter
  // (documented here and in its generated flat file) rides alongside.
  "docs-site mcp/reference.md": readSection("mcp"),
  "llms-mcp.txt": read("../../llms-mcp.txt"),
} as const;

/**
 * Pull the description literal a `server.registerTool(...)` registration
 * carries in its config's `description`. It is always a plain double-quoted
 * string in this file, so the literal round-trips through JSON.parse.
 */
function toolDescription(name: string): string {
  const anchor = `server.registerTool(\n  "${name}",\n  {\n    description: `;
  const at = INDEX_SRC.indexOf(anchor);
  assert.notEqual(at, -1, `server.registerTool("${name}", ...) is not registered in src/index.ts`);
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
  "Run402 cannot decrypt your vault or repository history. Deployment artifacts remain a disclosed plaintext custody boundary.";
const CLAIM_ACTIVATION = "Activation requires vault admission by default; an explicit, audited override can bypass it.";
const CLAIM_RETENTION =
  "Retention is an operational promise of the platform, not a cryptographic guarantee against it (the host controls timestamps and bytes).";

/** The V0-A terminal-loss sentence — doctor and status state it verbatim. */
const TERMINAL_LOSS = "whole-machine or whole-keystore loss is terminal for vault history until human envelopes ship";

/** The KEYSTORE_MISSING next action — the terminal-loss statement's keystore phrase. */
const KEYSTORE_MISSING_ACTION = "restore ~/.config/run402/vault from backup or accept vault loss";

/** Durability is keystore-qualified. Stating the first half without the second is banned. */
const KEYSTORE_QUALIFIED_DURABILITY =
  "The vault protects source history from host-side loss while a principal keystore survives.";

/** The only permitted scoped confidentiality sentence (D57 / D168). */
const SCOPED_CONFIDENTIALITY =
  "source payload and repository-history content are ciphertext-only; the substrate retains only enumerated plaintext metadata and holds zero vault keys";

/**
 * vault-mirror-default — the recommended-default vocabulary. The framing
 * sentence is the ONE way the three-copies shape is stated; the finding prefix
 * and setup hint are the canonical openings of the two runtime sentences the
 * SDK owns (`VAULT_UNMIRRORED_FINDING_STATEMENT` composes the framing
 * sentence via a template literal, so only its prefix is a source literal).
 */
const MIRROR_THREE_COPIES =
  "the recommended shape is three copies: your working clone, the platform's replicated vault, and a mirror in storage you own";
const UNMIRRORED_FINDING_PREFIX = "this vault has no customer-held mirror copy yet";
const MIRROR_SETUP_HINT =
  "recommended: 'run402 repos mirror <destination>' (an s3:// bucket or a local directory) starts the customer-owned mirror — every later capture is mirrored to it automatically, and it is the copy that stays in your custody";

/**
 * vault-byo-primary-bucket (design D4) — the degraded-read mechanism
 * sentence (`VAULT_DEGRADED_READ_STATEMENT`), the invariant part of the
 * one stderr line a degraded chain/payload read prints. Mechanism-only —
 * never a confidentiality claim.
 */
const DEGRADED_READ_STATEMENT =
  "run402 is unreachable — this read is served from your mirror; it proves validity, not freshness; a later push still requires the gateway";

/**
 * vault-byo-primary-bucket (task 1.4) — the three BYO copy sentences.
 * INERT as of this fold: nothing emits them yet (Phase 2/3 wire the
 * allocation/doctor/`repos view` surfaces). Pinned here anyway, same as
 * every other canonical constant in this gate, so the wording is locked
 * BEFORE it ships rather than reviewed after.
 */
const BYO_HEADLINE = "your source ciphertext never touches our infrastructure — not even encrypted";
const BYO_NO_PAYLOAD_COPY =
  "run402 holds no payload copy of a BYO vault — only the small signed chain; your primary bucket is the sole copy of your source until you add a second customer-held location";
const BYO_UNMIRRORED_REMEDY =
  "add a second customer-held location: 'run402 repos mirror <destination>' works unchanged against a different destination — for a BYO vault this is your only additional copy, since run402 holds no payload copy of its own";

/** Verbatim from the protocol's banned-copy list, plus the two forbidden unqualified patterns (D168). */
const BANNED_PHRASES = [
  "cannot read your source",
  "no release ever activates unvaulted",
  "stops the bleeding",
  "stores ciphertext only",
  "storage with receipts",
] as const;

/** Everything an agent or a reader can see of this feature's copy. */
const CORPUS = [EXPAND_SRC, STORE_SRC, toolDescription("expand_result")].join("\n");

/**
 * Strip markdown emphasis + code markers and collapse whitespace, so markup can
 * never split a rendered claim. `**Run402 cannot decrypt …**` and the plain
 * sentence must be the same string to this gate — otherwise bolding half a
 * sentence silently disables the check on it.
 */
function normalize(text: string): string {
  return text.replace(/[*`]/g, "").replace(/\s+/g, " ");
}

const NORMALIZED_DOCS = Object.fromEntries(
  Object.entries(DOC_SURFACES).map(([name, text]) => [name, normalize(text)]),
) as Record<keyof typeof DOC_SURFACES, string>;

describe("vault copy — banned phrases", () => {
  for (const phrase of BANNED_PHRASES) {
    it(`never says "${phrase}"`, () => {
      assert.equal(
        CORPUS.toLowerCase().includes(phrase.toLowerCase()),
        false,
        `"${phrase}" is on the protocol's banned-copy list because it overclaims. Use the approved sentence instead — do not paraphrase it.`,
      );
    });

    for (const [name, text] of Object.entries(NORMALIZED_DOCS)) {
      it(`${name} never says "${phrase}"`, () => {
        assert.equal(
          text.toLowerCase().includes(phrase.toLowerCase()),
          false,
          `${name} contains "${phrase}", which is on the protocol's banned-copy list because it overclaims. Use the approved sentence — do not paraphrase it.`,
        );
      });
    }
  }
});

/**
 * The banned CLASS, not just the banned list.
 *
 * The durability overclaim's natural English form — "so an agent that lost its
 * laptop can recover the code that produced the running release" — contains no
 * banned phrase, and it has already slipped past a literal scan more than once.
 * So: any file that talks about the vault AND pitches surviving the loss of a
 * machine must carry the keystore qualifier in the SAME file.
 */
describe("vault copy — machine-loss claims carry the keystore qualifier", () => {
  const MACHINE_LOSS = /\b(lost|lose|losing|loss of)\b[^.]{0,80}\b(machine|laptop|keystore)\b|\b(machine|whole-machine|laptop)[- ]loss\b/i;

  for (const [name, text] of Object.entries(NORMALIZED_DOCS)) {
    it(`${name}: mentions machine loss only with the keystore-qualified sentence`, () => {
      if (!text.toLowerCase().includes("vault")) return;
      if (!MACHINE_LOSS.test(text)) return;
      assert.ok(
        text.includes(normalize(KEYSTORE_QUALIFIED_DURABILITY)),
        `${name} pitches surviving the loss of a machine but does not carry the keystore-qualified durability sentence. ` +
          `Whole-machine or whole-keystore loss is TERMINAL for vault history in V0-A; durability copy without the qualifier is banned.`,
      );
    });
  }
});

/**
 * Presence, per surface. A doc that names the vault but states none of its
 * claims is the other failure mode: a reader who only hears "encrypted Git
 * remote" has been told the marketing half and none of the scope.
 */
describe("vault copy — the doc surfaces state the claims", () => {
  const REQUIRED: Array<keyof typeof DOC_SURFACES> = [
    "README.md",
    "SKILL.md",
    "sdk/README.md",
    "cli/llms-cli.txt",
    "sdk/llms-sdk.txt",
    "openclaw/SKILL.md",
  ];

  for (const name of REQUIRED) {
    it(`${name} states the confidentiality claim verbatim`, () => {
      assert.ok(
        NORMALIZED_DOCS[name].includes(normalize(CLAIM_CONFIDENTIALITY)),
        "the confidentiality claim must appear verbatim, including the deployment-artifact custody sentence that scopes it",
      );
    });

    it(`${name} states the terminal-loss sentence verbatim`, () => {
      assert.ok(
        NORMALIZED_DOCS[name].includes(normalize(TERMINAL_LOSS)),
        "the terminal-loss sentence is a reviewed product commitment and is stated verbatim, not summarised",
      );
    });

    it(`${name} carries the scoped confidentiality sentence`, () => {
      assert.ok(
        NORMALIZED_DOCS[name].includes(normalize(SCOPED_CONFIDENTIALITY)),
        "the scoped sentence is the ONLY permitted form of the ciphertext claim",
      );
    });
  }

  it("the CLI reference states the activation and retention claims", () => {
    assert.ok(NORMALIZED_DOCS["cli/llms-cli.txt"].includes(normalize(CLAIM_ACTIVATION)));
    assert.ok(NORMALIZED_DOCS["cli/llms-cli.txt"].includes(normalize(CLAIM_RETENTION)));
  });

  it("the SDK reference states the activation and retention claims", () => {
    assert.ok(NORMALIZED_DOCS["sdk/llms-sdk.txt"].includes(normalize(CLAIM_ACTIVATION)));
    assert.ok(NORMALIZED_DOCS["sdk/llms-sdk.txt"].includes(normalize(CLAIM_RETENTION)));
  });

  it("the generated flat files match their docs-site sources on the claims", () => {
    // The generator is the only thing keeping these equal; if it stops running,
    // the agent-facing flat file and the human-facing page can disagree about
    // what the platform promises.
    assert.ok(NORMALIZED_DOCS["docs-site cli/reference.md"].includes(normalize(CLAIM_CONFIDENTIALITY)));
    assert.ok(NORMALIZED_DOCS["docs-site sdk/reference.md"].includes(normalize(CLAIM_CONFIDENTIALITY)));
  });
});

/**
 * vault-mirror-default — the mirror-as-recommended-default copy. The SDK's
 * crypto module is the canonical home of the runtime sentences (the CLI prints
 * them verbatim rather than hardcoding copy, same as the terminal-loss text),
 * and the CLI reference states the framing so an agent reading the docs is
 * taught the same door doctor and `repos view` name at runtime.
 */
describe("vault copy — the mirror recommended-default vocabulary", () => {
  const CRYPTO_SRC = read("../../sdk/src/namespaces/vault.crypto.ts");

  it("the SDK crypto module carries the three-copies framing sentence", () => {
    assert.ok(
      CRYPTO_SRC.includes(MIRROR_THREE_COPIES),
      "VAULT_MIRROR_THREE_COPIES_STATEMENT is the one approved framing of the three-copies shape — do not reword it",
    );
  });

  it("the SDK crypto module carries the vault_unmirrored finding opening", () => {
    assert.ok(
      CRYPTO_SRC.includes(UNMIRRORED_FINDING_PREFIX),
      "VAULT_UNMIRRORED_FINDING_STATEMENT's opening is worded to stay true in BOTH pre-clear states — do not reword it",
    );
  });

  it("the SDK crypto module carries the create-output mirror hint", () => {
    assert.ok(
      CRYPTO_SRC.includes(MIRROR_SETUP_HINT),
      "VAULT_MIRROR_SETUP_HINT is custody-scoped on purpose (never a recoverability claim) — do not reword it",
    );
  });

  for (const name of ["cli/llms-cli.txt", "docs-site cli/reference.md"] as const) {
    it(`${name} states the three-copies framing verbatim`, () => {
      assert.ok(
        NORMALIZED_DOCS[name].includes(normalize(MIRROR_THREE_COPIES)),
        "the three-copies framing is the approved recommended-default sentence — state it verbatim, never paraphrased",
      );
    });

    it(`${name} names the vault_unmirrored finding`, () => {
      assert.ok(
        NORMALIZED_DOCS[name].includes("vault_unmirrored"),
        "the standing finding is part of the documented contract — the reference must name it",
      );
    });
  }
});

/**
 * vault-byo-primary-bucket (design D4) — the degraded-read mechanism
 * sentence. Same pattern as the mirror-recommended-default block above: the
 * SDK's crypto module is the canonical home of the runtime sentence, printed
 * verbatim by the remote helper rather than hardcoded at the call site.
 */
describe("vault copy — the degraded-read mechanism sentence", () => {
  const CRYPTO_SRC = read("../../sdk/src/namespaces/vault.crypto.ts");

  it("the SDK crypto module carries the degraded-read statement verbatim", () => {
    assert.ok(
      CRYPTO_SRC.includes(DEGRADED_READ_STATEMENT),
      "VAULT_DEGRADED_READ_STATEMENT is the one approved wording for a degraded read's stderr line — do not reword it",
    );
  });

  it("vaultDegradedReadNote composes the stderr line from the canonical statement, never a hand-rolled one", () => {
    const SDK_NAMESPACE_SRC = read("../../sdk/src/namespaces/repos.ts");
    assert.ok(
      SDK_NAMESPACE_SRC.includes("VAULT_DEGRADED_READ_STATEMENT"),
      "vaultDegradedReadNote (sdk/src/namespaces/repos.ts) must print the canonical constant, not a paraphrase",
    );
  });
});

/**
 * vault-byo-primary-bucket (task 1.4) — the three BYO copy sentences.
 * Phase 1 protocol-coordination only: these constants are INERT (nothing
 * emits them yet — allocation, doctor, and `repos view` rendering are
 * Phase 2/3), so this block pins the wording in the SDK crypto module ahead
 * of the surfaces that will print it, same discipline as the mirror and
 * degraded-read blocks above. The headline statement is additionally
 * checked for structural BYO-only scoping: it must never appear bare in any
 * agent-facing or doc surface without "byo" nearby, so an accidental
 * copy-paste into managed-vault copy — where the sentence is FALSE — fails
 * this gate rather than shipping silently.
 */
describe("vault copy — the BYO primary-bucket vocabulary (Phase 1, inert)", () => {
  const CRYPTO_SRC = read("../../sdk/src/namespaces/vault.crypto.ts");

  it("the SDK crypto module carries the rung-3 headline statement verbatim", () => {
    assert.ok(
      CRYPTO_SRC.includes(BYO_HEADLINE),
      "VAULT_BYO_HEADLINE_STATEMENT is the one approved wording of the rung-3 headline — do not reword it",
    );
  });

  it("the headline statement's own doc comment states it must never be a blanket claim", () => {
    const commentWindow = CRYPTO_SRC.slice(
      Math.max(0, CRYPTO_SRC.indexOf(BYO_HEADLINE) - 1500),
      CRYPTO_SRC.indexOf(BYO_HEADLINE),
    );
    assert.ok(
      /never|only|storage_profile.*byo/i.test(commentWindow) && commentWindow.toLowerCase().includes("managed"),
      "VAULT_BYO_HEADLINE_STATEMENT's doc comment must name that it is FALSE for a managed vault and scope it to storage_profile:\"byo\" only",
    );
  });

  it("the SDK crypto module carries the no-payload-copy disclosure verbatim", () => {
    assert.ok(
      CRYPTO_SRC.includes(BYO_NO_PAYLOAD_COPY),
      "VAULT_BYO_NO_PAYLOAD_COPY_STATEMENT is the one approved wording of the allocation-time disclosure — do not reword it",
    );
  });

  it("the SDK crypto module carries the BYO vault_unmirrored remedy verbatim", () => {
    assert.ok(
      CRYPTO_SRC.includes(BYO_UNMIRRORED_REMEDY),
      "VAULT_BYO_UNMIRRORED_REMEDY_STATEMENT is the one approved wording of the BYO remedy — do not reword it",
    );
  });

  it("the headline statement never appears bare (unscoped to BYO) in any agent-facing or doc surface", () => {
    // Nothing emits it yet (Phase 2/3), so this is a forward guard: the day a
    // surface starts printing it, this test forces "byo" to ride along in the
    // same neighborhood rather than letting the sentence drift into a
    // blanket claim about every vault.
    const WINDOW = 200;
    const surfaces: Array<[string, string]> = [["CORPUS", CORPUS], ...Object.entries(NORMALIZED_DOCS)];
    for (const [name, text] of surfaces) {
      const idx = text.indexOf(BYO_HEADLINE);
      if (idx === -1) continue;
      const nearby = text.slice(Math.max(0, idx - WINDOW), idx + BYO_HEADLINE.length + WINDOW).toLowerCase();
      assert.ok(
        nearby.includes("byo"),
        `${name} prints the rung-3 headline without "byo" nearby — this sentence is FALSE for a managed vault and must never appear as a blanket claim`,
      );
    }
  });

  it("banned-phrase scan stays green with the BYO constants present", () => {
    for (const phrase of BANNED_PHRASES) {
      assert.equal(CRYPTO_SRC.toLowerCase().includes(phrase.toLowerCase()), false, `vault.crypto.ts contains banned phrase "${phrase}"`);
    }
  });

  it("machine-loss scan stays green with the BYO constants present", () => {
    const MACHINE_LOSS = /\b(lost|lose|losing|loss of)\b[^.]{0,80}\b(machine|laptop|keystore)\b|\b(machine|whole-machine|laptop)[- ]loss\b/i;
    for (const statement of [BYO_HEADLINE, BYO_NO_PAYLOAD_COPY, BYO_UNMIRRORED_REMEDY]) {
      assert.equal(MACHINE_LOSS.test(statement), false, `"${statement}" unexpectedly matches the machine-loss pattern`);
    }
  });
});

/**
 * The vendored protocol docs (docs/kygit/) are byte-identical mirrors of the
 * private working drafts — the SOURCE of the claims vocabulary, not derivative
 * copy. They are deliberately NOT in DOC_SURFACES: the threat model quotes the
 * banned phrases on purpose (its §8 banned-copy table), so the banned-phrase
 * scan would false-positive on them. What CAN rot is the mirror itself — a
 * protocol revision in the private repo that forgets to re-sync this copy. So:
 * pin the mirror against the same constants this gate enforces everywhere else,
 * and pin its revision to the vendored vector set's.
 */
describe("vault copy — the vendored protocol docs stay in sync", () => {
  const THREAT_MODEL = normalize(read("../../docs/kygit/threat-model.md"));
  const PROTOCOL_HEAD = read("../../docs/kygit/protocol-v0.md").split("\n", 1)[0];

  it("the vendored threat model states all three claims verbatim", () => {
    for (const claim of [CLAIM_CONFIDENTIALITY, CLAIM_ACTIVATION, CLAIM_RETENTION]) {
      assert.ok(
        THREAT_MODEL.includes(normalize(claim)),
        `docs/kygit/threat-model.md no longer carries the claim "${claim}" — the mirror has drifted from the constants in this gate (or vice versa); re-sync from the private working draft and update BOTH in the same commit`,
      );
    }
  });

  it("the vendored threat model carries the qualified sentences", () => {
    for (const sentence of [TERMINAL_LOSS, KEYSTORE_QUALIFIED_DURABILITY, SCOPED_CONFIDENTIALITY]) {
      assert.ok(
        THREAT_MODEL.includes(normalize(sentence)),
        `docs/kygit/threat-model.md no longer carries "${sentence}" — mirror and gate constants must change together`,
      );
    }
  });

  it("the keystore phrase is stated verbatim by the SDK, the vendored error registry, and the vendored threat model", () => {
    assert.ok(read("../../sdk/src/node/vault-publication.ts").includes(`"${KEYSTORE_MISSING_ACTION}"`), "vault-publication.ts's KEYSTORE_MISSING next action drifted");
    assert.ok(read("../../test-vectors/r402s-v0/schemas/errors.json").includes(KEYSTORE_MISSING_ACTION), "the vendored errors.json KEYSTORE_MISSING next_action drifted");
    assert.ok(THREAT_MODEL.includes(normalize(KEYSTORE_MISSING_ACTION)), "docs/kygit/threat-model.md no longer carries the keystore phrase");
  });

  it("the vendored threat model still lists every banned phrase in its banned-copy table", () => {
    // The banned list's authority is the threat model; if a phrase leaves the
    // mirror, this gate is enforcing a rule its stated source no longer states.
    for (const phrase of BANNED_PHRASES.slice(0, 3)) {
      assert.ok(THREAT_MODEL.includes(phrase), `"${phrase}" is missing from the mirror's banned-copy table`);
    }
  });

  it("the vendored protocol's revision matches the vendored vector set's", () => {
    const vectors = JSON.parse(read("../../test-vectors/r402s-v0/vectors.json")) as { "x-r402s-revision": string };
    assert.ok(
      PROTOCOL_HEAD.includes(`rev ${vectors["x-r402s-revision"]}`),
      `docs/kygit/protocol-v0.md's title line ("${PROTOCOL_HEAD}") does not carry rev ${vectors["x-r402s-revision"]} — one of the two vendored sets was re-synced without the other`,
    );
  });
});
