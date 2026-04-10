# R.2 — zk Proof Generation Prototype

**Date:** 2026-04-10
**Phase:** R (zk-email & KDF Research Spike)
**Status:** Blueprint defined, awaiting hands-on test with real DKIM email

## What's Done

### Blueprint Definition (`scripts/research/define-kysigned-blueprint.ts`)

The kysigned Blueprint is fully defined with three decomposed regex patterns:

1. **`approvalText`** (body, maxLength=16):
   Matches `I APPROVE` (case-insensitive) on a standalone line. First-match semantics ensure it captures the reply text above any quoted content.

2. **`senderEmail`** (header, maxLength=256, **hashed**):
   Extracts the `From:` email address and outputs `Poseidon(email)` as the public signal — the raw email never leaves the proof. Handles both `From: user@example.com` and `From: Display Name <user@example.com>`.

3. **`subject`** (header, maxLength=512):
   Extracts the full Subject as a public signal. The on-chain contract parses `envelopeId` + `docHash` from it.

### Circuit Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `emailBodyMaxLength` | 4096 | Approval replies are short (<1KB typical) |
| `emailHeaderMaxLength` | 1024 | Standard header block |
| `ignoreBodyHashCheck` | false | MUST verify body contains `I APPROVE` |
| `removeSoftLinebreaks` | true | Handle quoted-printable encoding |
| `shaPrecomputeSelector` | TBD | Set after email template finalized (Phase 2R.15) |

### Public Signals (on-chain)

| Signal | Type | Source |
|--------|------|--------|
| `pubkeyHash` | bytes32 | Poseidon(DKIM public key) — from EmailVerifier |
| `approvalText` | string | "I APPROVE" — from body regex |
| `senderEmail` | bytes32 | Poseidon(From email) — hashed for privacy |
| `subject` | string | Full subject containing envelopeId + docHash |

## What Needs Hands-on Testing

### Step 1: Obtain a test .eml file

Send a real signing email from the deployed kysigned instance, reply "I APPROVE" from a Gmail (or similar DKIM-signing provider) mailbox, and export the raw MIME as a `.eml` file.

Alternatively, use the run402 mailbox API to capture a real DKIM-signed email:
```bash
# Poll the kysigned project mailbox for inbound messages
curl -H "authorization: Bearer $SERVICE_KEY" \
  "https://api.run402.com/mailboxes/v1/$MAILBOX_ID/messages"

# Fetch raw MIME of a specific message
curl -H "authorization: Bearer $SERVICE_KEY" \
  "https://api.run402.com/mailboxes/v1/$MAILBOX_ID/messages/$MSG_ID/raw"
```

### Step 2: Submit the Blueprint to the registry

Either:
- **Programmatic:** `ZKEMAIL_AUTH=<token> npx tsx scripts/research/define-kysigned-blueprint.ts`
- **Manual:** paste the props into the web UI at https://sdk.prove.email/

Circuit compilation takes ~15 minutes.

### Step 3: Generate and verify a proof

```bash
KYSIGNED_BLUEPRINT_SLUG=kychee/kysigned-approval@v1 \
  npx tsx scripts/research/generate-proof-prototype.ts test/fixtures/sample-approval-reply.eml
```

### Measurements to record

| Metric | Expected | Actual |
|--------|----------|--------|
| Proof generation time (server) | <5s | TBD |
| Proof generation time (local) | ~15s (halo2) or minutes (circom) | TBD |
| Proof size | ~260 bytes (Groth16) | TBD |
| Off-chain verification time | <100ms | TBD |
| On-chain verification gas | ~250K gas | TBD |
| Circuit constraints | ~3-5M (body verification) | TBD |

## Architecture Decision

**Server-side Groth16 proving** is the clear choice for kysigned:

- The operator (not the signer) generates the proof after receiving the DKIM reply
- No client-side proving needed — the signer never runs any code
- <5s generation, <$0.01/proof, ~260 bytes on-chain
- The signer's email privacy is maintained: only `Poseidon(email)` appears on-chain

## Dependencies

```
@zk-email/sdk     ^2.0.11   Blueprint API, proof generation
@zk-email/helpers  ^6.4.2   DKIM parsing, circuit input preparation
snarkjs            latest    Groth16 proof generation (used by SDK internally)
```

These will be added to `package.json` in Phase 2R when the engine rework begins. For now they're research-only — the prototype scripts use dynamic imports.

## Next Steps

- R.3: Confirm Groth16 as the on-chain verifier (gas cost measurement on Base Sepolia)
- R.9: Draft `EvidenceKeyRegistry.sol` using Poseidon key hashing (matching zk-email's format)
- Phase 2R.10: Wrap the proof generation into a production module
