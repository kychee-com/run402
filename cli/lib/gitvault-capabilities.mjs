/**
 * gitvault-capabilities.mjs — the capability ledger for the GitVault
 * marketing surface (openspec/changes/gitvault-page-truth-gate, design D1).
 *
 * THIS FILE IS MARKETING-CLAIM GROUND TRUTH. run402-private's page-truth
 * gate (`scripts/check-gitvault-page-truth.mjs`) resolves the PUBLISHED
 * `run402` package, reads these flags out of the generated
 * `cli/gitvault-surface.json`, and fails the GitVault product page's build
 * when a claim marker contradicts what is asserted here. It lives NEXT TO
 * `command-manifest.mjs` so the change that flips a capability (ships a
 * feature, retires a spelling) is the SAME change that flips the fact this
 * ledger asserts — no second bookkeeping site, no drift window. Flip the
 * behavior and this file in the same change, never one without the other.
 */

export const GITVAULT_CAPABILITIES = {
  // `repos access repair` / `repos access revoke-key` /
  // `repos access declare-exposure` (rev 42, D193-D203) drive a real epoch
  // rotation against the gateway — revocation is a live, shipped feature.
  revocation_live: true,
  // `Gitvault#reconcileEnvelopeRecipients` (gitvault-human-envelopes task
  // 4.1's ADD-path workaround) runs automatically after every successful
  // `push()`/`deploy()` and wraps the vault's current epoch key to every org
  // member who has published an encryption key but has no `key_envelope` on
  // the vault yet — multi-recipient human envelope addition is live in
  // production, not aspirational.
  human_envelope_add_live: true,
  // `repos mirror` reads/writes a mirror destination beside the keystore and
  // moves real bytes into a customer-owned bucket.
  mirror_live: true,
  // `repos create --byo <s3://bucket/prefix>` allocates a
  // `storage_profile: "byo"` vault whose payload ciphertext is written by
  // the client straight to the customer's own bucket (create-only probe
  // fail-closed before allocation; chain-copy dual-write; attested finalize
  // with `storage_verification: "client_attested"`; degraded reads from the
  // destination; fsck absence check) — shipped end to end in the same
  // change that flips this flag (gitvault-byo-primary-bucket, Phase 3).
  byo_live: true,
  // `repos recover` materializes a git repository from a mirror source,
  // offline, with no server call.
  recover_live: true,
  // `repos create` allocates the vault IMMEDIATELY — the moment the repo
  // starts existing — not lazily deferred to first push.
  allocation: "create_immediate",
  // `repos snapshot` refuses to capture a dirty working tree
  // (`SNAPSHOT_DIRTY_TREE`) by default; `--allow-dirty` opts in explicitly.
  snapshot_dirty_default: "refuse",
};
