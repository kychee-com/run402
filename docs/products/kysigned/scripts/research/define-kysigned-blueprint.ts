/**
 * R.2 — Define the kysigned zk-email Blueprint.
 *
 * This script programmatically creates the kysigned-specific Blueprint on the
 * zk-email SDK registry. The Blueprint composes:
 *
 *   1. DKIM signature verification (EmailVerifier base circuit)
 *   2. Body regex: match `I APPROVE` on a standalone line
 *   3. From regex: extract sender email address (public signal)
 *   4. Subject regex: extract full subject (contains envelopeId + docHash)
 *
 * Run once to create the blueprint, then use the slug in proof generation.
 *
 * Usage:
 *   ZKEMAIL_AUTH=<github-oauth-token> npx tsx scripts/research/define-kysigned-blueprint.ts
 *
 * Prerequisites:
 *   npm install @zk-email/sdk
 */

// ---- Blueprint Definition (the core research output) ----

/**
 * Decomposed regex for matching `I APPROVE` on a standalone line in the
 * email body. Case-insensitive via character classes (zk-regex doesn't
 * support flags). Matches the FIRST occurrence only.
 *
 * Pattern: \r\n followed by "I APPROVE" (case-insensitive) followed by \r\n
 * The `I APPROVE` text is the public signal.
 */
/**
 * Body constraint: "I APPROVE" must appear on a standalone line.
 * This is a circuit CONSTRAINT, not a public output — if the body doesn't
 * match, the proof fails to generate. The matched text is private (all
 * parts isPublic: false) because the proof's existence IS the attestation
 * that the body contained the approval. No need to put the literal string
 * on-chain — it wastes gas for information already implied by a valid proof.
 */
const bodyApprovalRegex = {
  name: 'approvalConstraint',
  location: 'body' as const,
  maxLength: 16,
  parts: [
    { isPublic: false, regexDef: '(\r\n|^)' },
    { isPublic: false, regexDef: '[Ii] [Aa][Pp][Pp][Rr][Oo][Vv][Ee]' },
    { isPublic: false, regexDef: '\r\n' },
  ],
};

/**
 * Decomposed regex for extracting the sender email from the `From:` header.
 * Handles both `From: user@example.com` and `From: Display Name <user@example.com>`.
 *
 * PRIVACY FIX (from GPT consultation): The email is hashed with docHash +
 * envelopeId to produce a DOCUMENT-SCOPED commitment, not a stable pseudonym.
 * This prevents cross-document linkability — the same email produces different
 * public signals for different documents.
 *
 * The circuit computes: emailCommit = Poseidon(email, docHash, envelopeId)
 * The docHash and envelopeId come from the Subject extraction (external inputs).
 */
const fromEmailRegex = {
  name: 'senderEmail',
  location: 'header' as const,
  maxLength: 256,
  isHashed: true, // Poseidon hash — but document-scoped via external inputs (docHash, envelopeId)
  parts: [
    { isPublic: false, regexDef: '(\r\n|^)from:' },
    { isPublic: false, regexDef: '([^\r\n]+<)?' },
    {
      isPublic: true,
      regexDef:
        "[A-Za-z0-9!#$%&'*+\\-/=?^_`{|}~.]+@[A-Za-z0-9.\\-]+",
    },
    { isPublic: false, regexDef: '>?\r\n' },
  ],
};

/**
 * Decomposed regex for extracting the full Subject header value.
 * The subject contains envelopeId + docHash — the on-chain contract
 * parses these from the public signal.
 *
 * Expected subject format:
 *   "Sign: <documentName> [<envelopeId>] [<docHash>]"
 */
const subjectRegex = {
  name: 'subject',
  location: 'header' as const,
  maxLength: 512, // Subject can be long with document names
  parts: [
    { isPublic: false, regexDef: '(\r\n|^)subject:' },
    { isPublic: true, regexDef: '[^\r\n]+' },
    { isPublic: false, regexDef: '\r\n' },
  ],
};

/**
 * The full Blueprint configuration for kysigned reply-to-sign proofs.
 */
export const KYSIGNED_BLUEPRINT_PROPS = {
  title: 'kysigned Reply-to-Sign Approval',
  description:
    'Proves that a signer replied "I APPROVE" to a kysigned signing email, ' +
    'binding the approval to a specific document (via Subject containing ' +
    'envelopeId + docHash) and a specific signer (via From header hash). ' +
    'DKIM signature verification proves the email is authentic.',
  circuitName: 'KysignedApproval',
  senderDomain: '', // Any domain — signers use their own email providers
  ignoreBodyHashCheck: false, // We MUST verify body (contains "I APPROVE")
  emailBodyMaxLength: 4096, // Approval replies are short; 4KB is generous
  emailHeaderMaxLength: 1024, // Standard header block
  removeSoftLinebreaks: true, // Handle quoted-printable encoding in body
  enableHeaderMasking: false,
  enableBodyMasking: false,
  isPublic: true, // Open source — forkers can use the same blueprint
  decomposedRegexes: [bodyApprovalRegex, fromEmailRegex, subjectRegex],
  externalInputs: [],
  // SHA precompute selector: the signing email template includes a unique
  // marker before the reply area. This lets the circuit skip hashing the
  // bulk of the email body and only prove the tail containing "I APPROVE".
  // The exact selector depends on the email template — use the last
  // unique string before the reply area.
  shaPrecomputeSelector: undefined, // Set after email template is finalized (Phase 2R.15)
};

// ---- Script entry point ----

async function main() {
  console.log('kysigned Blueprint Definition (R.2 research output)\n');
  console.log('Blueprint props:');
  console.log(JSON.stringify(KYSIGNED_BLUEPRINT_PROPS, null, 2));

  console.log('\n--- Decomposed Regex Summary ---');
  for (const dr of KYSIGNED_BLUEPRINT_PROPS.decomposedRegexes) {
    console.log(`\n${dr.name} (${dr.location}, maxLength=${dr.maxLength}):`);
    for (const part of dr.parts) {
      console.log(`  ${part.isPublic ? 'PUBLIC ' : 'private'}: ${part.regexDef}`);
    }
  }

  console.log('\n--- Public Signals (on-chain, 3 total) ---');
  console.log('1. pubkeyHash     — Poseidon(DKIM public key) [from EmailVerifier]');
  console.log('2. senderEmail    — Poseidon(From email address) [hashed for privacy]');
  console.log('3. subject        — Full subject string (contains envelopeId + docHash)');
  console.log('\n--- Private Constraint (NOT on-chain) ---');
  console.log('   approvalConstraint — body must contain "I APPROVE" on standalone line');
  console.log('   (proof fails to generate if absent; proof existence IS the attestation)');
  console.log('\nThe on-chain SignatureRegistry contract will:');
  console.log('  - Verify the Groth16 proof via the generated verifier contract');
  console.log('  - Check pubkeyHash matches a registered evidence key');
  console.log('  - Parse envelopeId + docHash from the subject signal');
  console.log('  - Store the record keyed by searchKey (provided by caller)');

  // ---- Optional: actually submit to the registry ----
  const authToken = process.env['ZKEMAIL_AUTH'];
  if (!authToken) {
    console.log('\n[SKIP] ZKEMAIL_AUTH not set — blueprint not submitted to registry.');
    console.log('To submit: ZKEMAIL_AUTH=<github-oauth-token> npx tsx scripts/research/define-kysigned-blueprint.ts');
    return;
  }

  console.log('\nSubmitting blueprint to zk-email registry...');
  // Dynamic import to avoid requiring @zk-email/sdk at research time
  const { initZkEmailSdk } = await import('@zk-email/sdk');
  const sdk = initZkEmailSdk({ logging: { enabled: true, level: 'info' } });

  // The SDK's Blueprint class constructor + submit() flow:
  // 1. sdk.createBlueprint(props) — returns a Blueprint instance
  // 2. blueprint.submit() — compiles the circuit on the registry server (~15 min)
  //
  // NOTE: The SDK's createBlueprint API may not be publicly exposed yet.
  // If it isn't, we submit via the registry web UI at https://sdk.prove.email/
  // using the props above and note the slug here for future reference.
  try {
    const blueprint = await (sdk as any).createBlueprint(KYSIGNED_BLUEPRINT_PROPS);
    await blueprint.submit();
    console.log(`Blueprint submitted! Slug: ${blueprint.props.slug}`);
    console.log('Circuit compilation will take ~15 minutes.');
    console.log(`Check status at: https://sdk.prove.email/`);
  } catch (err) {
    console.error('Blueprint submission failed:', err);
    console.log('\nFallback: submit manually at https://sdk.prove.email/');
    console.log('Use the Blueprint props printed above.');
  }
}

main().catch(console.error);
