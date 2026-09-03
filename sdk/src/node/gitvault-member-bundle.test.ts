/**
 * gitvault-recovery-custody — the member recovery bundle open path.
 *
 * The GOLDEN fixture below was sealed by the CANONICAL implementation (the
 * private repo's `apps/git/public/lib/r402s-crypto.js` "Source-access wrapper
 * custody" section — the module the console actually seals wrappers with),
 * with a fixed scalar and a captured recovery code. This SDK's independent
 * open path must recover the exact scalar from those exact bytes — the
 * cross-implementation proof that a console-sealed wrapper opens offline. A
 * disagreement here is a defect in ONE of the two implementations (or an
 * unpinned constant); never regenerate the fixture to make the test pass
 * without diffing the constants first.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSourceWrapperContext,
  bytesToHex,
  ekFingerprint,
  fromBase64url,
  normalizeSourceRecoveryCode,
  openSourceWrapper,
} from "../namespaces/gitvault.crypto.js";
import {
  GITVAULT_MEMBER_BUNDLE_FORMAT,
  GITVAULT_MEMBER_BUNDLE_MIRROR_PREFIX,
  discoverMemberBundles,
  parseMemberRecoveryBundle,
  unwrapMemberRecoveryBundle,
  type GitvaultMemberRecoveryBundle,
} from "./gitvault-member-bundle.js";
import type { GitvaultMirrorBackend } from "./gitvault-mirror-backend.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

// ─── Golden fixture (sealed by apps/git/public/lib/r402s-crypto.js) ─────────
const GOLDEN = {
  code_display: "SRC1-E21A-Z619-AK42-T962-5H61-XNEV-089A-27QC-Q",
  code_core: "E21AZ619AK42T9625H61XNEV089A27QC",
  rp_id: "console.run402.com",
  principal_id: "aa11aa11-1111-4111-8111-111111111111",
  encryption_key_id: "bb22bb22-2222-4222-8222-222222222222",
  wrapper_id: "cc33cc33-3333-4333-8333-333333333333",
  scalar_hex: "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
  public_key_b64u: "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw",
  ek_fingerprint: "ek_aaa8fff703b50b2297f4f6e13508f724",
  blob: "swrap2_cTF1tA4vPJ-WgGnStTyomsKk0y767lbm6-9sZq73D1i_thpDIoZC2lpheAHufaNDpbTXLhwPcdUE_EQWNFl086u2ue42yQg-awCyzdfxUH90WcywlDzlsp_fL4R-d36MxSBrc4WHSX0",
} as const;

function goldenBundle(overrides: Partial<GitvaultMemberRecoveryBundle> = {}): GitvaultMemberRecoveryBundle {
  return {
    format: GITVAULT_MEMBER_BUNDLE_FORMAT,
    principal_id: GOLDEN.principal_id,
    encryption_key_id: GOLDEN.encryption_key_id,
    ek_fingerprint: GOLDEN.ek_fingerprint,
    public_key: GOLDEN.public_key_b64u,
    suite: "r402s-1",
    custody_scheme: "wrapped_random_v1",
    wrappers: [
      {
        wrapper_id: GOLDEN.wrapper_id,
        kind: "recovery_code",
        format_version: "swrap2",
        credential_subject: null,
        wrapper_ciphertext: GOLDEN.blob,
        blob_sha256: "882547972407ec3e73cca63f5c86c20515325c01dfc6a604981c0d806647c86a",
        created_at: "2026-08-29T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function codeAssertLocal(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    assert.equal((e as { code?: string }).code, code, `expected ${code}, got ${(e as Error).message}`);
    return;
  }
  assert.fail(`expected ${code} to be thrown`);
}

describe("source recovery code normalization (pinned)", () => {
  it("accepts the display form and returns the 32-char core", () => {
    assert.equal(normalizeSourceRecoveryCode(GOLDEN.code_display), GOLDEN.code_core);
  });
  it("is case/dash/ambiguity tolerant (0/O, 1/I/L)", () => {
    const sloppy = GOLDEN.code_display.toLowerCase().replaceAll("-", " ").replace("0", "O").replace("1", "l");
    assert.equal(normalizeSourceRecoveryCode(sloppy), GOLDEN.code_core);
  });
  it("catches a typo via the check character, locally, by name", () => {
    const flipped = GOLDEN.code_display.replace("E21A", "E22A");
    codeAssertLocal(() => normalizeSourceRecoveryCode(flipped), "RECOVERY_CODE_CHECKSUM_INVALID");
  });
  it("refuses a truncated code by name", () => {
    codeAssertLocal(() => normalizeSourceRecoveryCode("SRC1-E21A"), "RECOVERY_CODE_CHECKSUM_INVALID");
  });
});

describe("swrap2 open — cross-implementation golden", () => {
  const context = () =>
    buildSourceWrapperContext({
      rp_id: GOLDEN.rp_id,
      principal_id: GOLDEN.principal_id,
      encryption_key_id: GOLDEN.encryption_key_id,
      wrapper_id: GOLDEN.wrapper_id,
      kind: "recovery_code",
      credential_subject: null,
      member_public_key: fromBase64url(GOLDEN.public_key_b64u),
    });

  it("opens the console-sealed blob to the exact scalar", () => {
    const scalar = openSourceWrapper({ kind: "recovery_code", ikm: utf8ToBytes(GOLDEN.code_core), blob: GOLDEN.blob, context: context() });
    assert.equal(bytesToHex(scalar), GOLDEN.scalar_hex);
  });
  it("the golden fingerprint matches ekFingerprint of the golden public key", () => {
    assert.equal(ekFingerprint(fromBase64url(GOLDEN.public_key_b64u)), GOLDEN.ek_fingerprint);
  });
  it("a wrong code fails closed as WRAPPER_DID_NOT_OPEN", () => {
    const wrongCore = GOLDEN.code_core.slice(0, 31) + (GOLDEN.code_core.endsWith("A") ? "B" : "A");
    codeAssertLocal(() => openSourceWrapper({ kind: "recovery_code", ikm: utf8ToBytes(wrongCore), blob: GOLDEN.blob, context: context() }), "WRAPPER_DID_NOT_OPEN");
  });
  it("a wrong rp_id in the context fails closed (the context binding is real)", () => {
    const wrongContext = buildSourceWrapperContext({
      rp_id: "git.run402.com",
      principal_id: GOLDEN.principal_id,
      encryption_key_id: GOLDEN.encryption_key_id,
      wrapper_id: GOLDEN.wrapper_id,
      kind: "recovery_code",
      credential_subject: null,
      member_public_key: fromBase64url(GOLDEN.public_key_b64u),
    });
    codeAssertLocal(() => openSourceWrapper({ kind: "recovery_code", ikm: utf8ToBytes(GOLDEN.code_core), blob: GOLDEN.blob, context: wrongContext }), "WRAPPER_DID_NOT_OPEN");
  });
  it("an swrap1_ (probe-era) blob is refused by name, never decoded", () => {
    codeAssertLocal(() => openSourceWrapper({ kind: "recovery_code", ikm: utf8ToBytes(GOLDEN.code_core), blob: "swrap1_" + GOLDEN.blob.slice(7), context: context() }), "WRAPPER_FORMAT_UNSUPPORTED");
  });
});

describe("unwrapMemberRecoveryBundle", () => {
  it("recovers the member identity from bundle + code (rp_id defaulted)", () => {
    const result = unwrapMemberRecoveryBundle({ bundle: goldenBundle(), source_recovery_code: GOLDEN.code_display });
    assert.equal(result.private_key_hex, GOLDEN.scalar_hex);
    assert.equal(result.fingerprint, GOLDEN.ek_fingerprint);
    assert.equal(result.wrapper_id, GOLDEN.wrapper_id);
    assert.equal(result.rp_id_used, GOLDEN.rp_id); // the default IS the seal-time host
  });
  it("bundle.rp_id wins over the default; an explicit rp_id wins over both", () => {
    const viaBundle = unwrapMemberRecoveryBundle({ bundle: goldenBundle({ rp_id: GOLDEN.rp_id }), source_recovery_code: GOLDEN.code_display });
    assert.equal(viaBundle.rp_id_used, GOLDEN.rp_id);
    codeAssertLocal(
      () => unwrapMemberRecoveryBundle({ bundle: goldenBundle({ rp_id: GOLDEN.rp_id }), source_recovery_code: GOLDEN.code_display, rp_id: "elsewhere.example" }),
      "WRAPPER_DID_NOT_OPEN",
    );
  });
  it("a PRF-only bundle refuses by name — raw PRF is not a recovery input", () => {
    const bundle = goldenBundle();
    bundle.wrappers = [{ ...bundle.wrappers[0]!, kind: "webauthn_prf", credential_subject: "cred-subject" }];
    codeAssertLocal(() => unwrapMemberRecoveryBundle({ bundle, source_recovery_code: GOLDEN.code_display }), "RECOVERY_BUNDLE_MISSING");
  });
  it("a typo'd code is caught before any wrapper read", () => {
    codeAssertLocal(() => unwrapMemberRecoveryBundle({ bundle: goldenBundle(), source_recovery_code: GOLDEN.code_display.replace("E21A", "E22A") }), "RECOVERY_CODE_CHECKSUM_INVALID");
  });
});

describe("parseMemberRecoveryBundle", () => {
  it("round-trips a valid bundle from JSON text", () => {
    const parsed = parseMemberRecoveryBundle(JSON.stringify(goldenBundle()));
    assert.equal(parsed.ek_fingerprint, GOLDEN.ek_fingerprint);
  });
  it("refuses a foreign format by name", () => {
    codeAssertLocal(() => parseMemberRecoveryBundle({ ...goldenBundle(), format: "r402s-member-recovery-bundle/v2" }), "RECOVERY_BUNDLE_INVALID");
  });
  it("refuses a bundle with no wrappers[] field", () => {
    const b = goldenBundle() as unknown as Record<string, unknown>;
    delete b.wrappers;
    codeAssertLocal(() => parseMemberRecoveryBundle(b), "RECOVERY_BUNDLE_INVALID");
  });
});

describe("discoverMemberBundles (mirror sidecars — availability hints)", () => {
  function memoryBackend(files: Record<string, string>): GitvaultMirrorBackend {
    return {
      describe: () => "memory",
      head: async (key) => (files[key] ? { size_bytes: files[key].length } as never : null),
      get: async (key) => (files[key] ? utf8ToBytes(files[key]) : null),
      putCreateOnly: async () => ({ created: false }),
      list: async (prefix = "") => Object.keys(files).filter((k) => k.startsWith(prefix)).sort(),
    };
  }

  it("reports parsable sidecars with identity hints and malformed ones with their error — never a silent skip", async () => {
    const backend = memoryBackend({
      [`${GITVAULT_MEMBER_BUNDLE_MIRROR_PREFIX}tal.json`]: JSON.stringify(goldenBundle()),
      [`${GITVAULT_MEMBER_BUNDLE_MIRROR_PREFIX}broken.json`]: "{not json",
      "head/0000000000000000": "unrelated",
    });
    const hints = await discoverMemberBundles(backend);
    assert.equal(hints.length, 2);
    const broken = hints.find((h) => h.key.endsWith("broken.json"))!;
    assert.equal(broken.bundle, null);
    assert.ok(broken.parse_error);
    const ok = hints.find((h) => h.key.endsWith("tal.json"))!;
    assert.equal(ok.ek_fingerprint, GOLDEN.ek_fingerprint);
    assert.deepEqual(ok.wrapper_kinds, ["recovery_code"]);
  });

  it("an empty prefix is an empty list", async () => {
    assert.deepEqual(await discoverMemberBundles(memoryBackend({})), []);
  });
});
