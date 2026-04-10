/**
 * R.2 — Prototype zk proof generation from a real DKIM-signed email.
 *
 * This script takes a raw .eml file (DKIM-signed reply containing "I APPROVE"),
 * feeds it through the kysigned Blueprint circuit, and generates a Groth16 proof.
 *
 * Usage:
 *   npx tsx scripts/research/generate-proof-prototype.ts <path-to-eml-file>
 *
 * Prerequisites:
 *   1. npm install @zk-email/sdk @zk-email/helpers
 *   2. The kysigned Blueprint must be compiled on the registry
 *      (either via define-kysigned-blueprint.ts or manually at sdk.prove.email)
 *   3. A real .eml file from a DKIM-signed reply
 *
 * To get a test .eml file:
 *   1. Send a test signing email from any kysigned instance
 *   2. Reply "I APPROVE" from a DKIM-signing provider (Gmail, Outlook, etc.)
 *   3. Export the raw MIME (.eml) from the email client
 *   4. Save it to test/fixtures/sample-approval-reply.eml
 *
 * Measurements (R.2 deliverables):
 *   - Proof generation time (server-side)
 *   - Proof size (bytes)
 *   - Verification time (off-chain)
 *   - Public signals structure
 */

import { readFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

// ---- Configuration ----

// The Blueprint slug — set this after the blueprint is compiled on the registry
const BLUEPRINT_SLUG = process.env['KYSIGNED_BLUEPRINT_SLUG'] || 'kychee/kysigned-approval@v1';

// Whether to use server-side proving (fast, ~5s) or local proving (slow, minutes)
const USE_SERVER_PROVING = true;

// ---- Main ----

async function main() {
  const emlPath = process.argv[2];
  if (!emlPath || !existsSync(emlPath)) {
    console.error('Usage: npx tsx scripts/research/generate-proof-prototype.ts <path-to-eml-file>');
    console.error('\nNo .eml file provided or file not found.');
    console.error('See the script header for instructions on obtaining a test .eml file.');
    process.exit(1);
  }

  console.log('=== kysigned R.2: zk Proof Generation Prototype ===\n');

  // 1. Read the raw email
  const rawEml = readFileSync(emlPath, 'utf-8');
  console.log(`Email file: ${emlPath} (${rawEml.length} bytes)`);

  // 2. Initialize the SDK
  const { initZkEmailSdk } = await import('@zk-email/sdk');
  const sdk = initZkEmailSdk({ logging: { enabled: true, level: 'info' } });

  // 3. Fetch the compiled Blueprint
  console.log(`\nFetching blueprint: ${BLUEPRINT_SLUG}`);
  const blueprint = await sdk.getBlueprint(BLUEPRINT_SLUG);
  console.log(`Blueprint status — client: ${blueprint.props.clientStatus}, server: ${blueprint.props.serverStatus}`);

  // 4. Validate the email against the blueprint
  console.log('\nValidating email against blueprint regex patterns...');
  const isValid = await blueprint.validateEmail(rawEml);
  if (!isValid) {
    console.error('ERROR: Email does not match the blueprint regex patterns.');
    console.error('Possible causes:');
    console.error('  - Email body does not contain "I APPROVE" on a standalone line');
    console.error('  - DKIM signature is missing or invalid');
    console.error('  - Email headers do not match expected format');
    process.exit(1);
  }
  console.log('Email validation: PASS');

  // 5. Generate the proof
  console.log(`\nGenerating proof (${USE_SERVER_PROVING ? 'server-side' : 'local'})`);
  const prover = blueprint.createProver({ isLocal: !USE_SERVER_PROVING });

  const t0 = performance.now();
  const proof = await prover.generateProof(rawEml);
  const t1 = performance.now();

  const proofGenTimeMs = t1 - t0;
  const proofBytes = JSON.stringify(proof.props.proofData);
  const proofSize = Buffer.byteLength(proofBytes, 'utf-8');

  console.log('\n=== Proof Generation Results ===');
  console.log(`Time:       ${(proofGenTimeMs / 1000).toFixed(2)}s`);
  console.log(`Proof size: ${proofSize} bytes (JSON-encoded)`);
  console.log(`Proof data: ${proofBytes.slice(0, 200)}...`);

  // 6. Examine public signals
  console.log('\n=== Public Signals ===');
  const publicOutputs = proof.props.publicData;
  console.log(JSON.stringify(publicOutputs, null, 2));

  // 7. Verify off-chain
  console.log('\nVerifying proof off-chain...');
  const t2 = performance.now();
  const verified = await blueprint.verifyProof(proof);
  const t3 = performance.now();

  console.log(`Verification: ${verified ? 'PASS' : 'FAIL'}`);
  console.log(`Verification time: ${(t3 - t2).toFixed(2)}ms`);

  // 8. Summary for R.2 deliverables
  console.log('\n=== R.2 Summary ===');
  console.log(`Proof generation time: ${(proofGenTimeMs / 1000).toFixed(2)}s (${USE_SERVER_PROVING ? 'server' : 'local'})`);
  console.log(`Proof size:            ${proofSize} bytes`);
  console.log(`Off-chain verify:      ${(t3 - t2).toFixed(2)}ms`);
  console.log(`Public signals count:  ${Object.keys(publicOutputs || {}).length}`);
  console.log(`Blueprint slug:        ${BLUEPRINT_SLUG}`);

  // 9. Try on-chain verification (Base Sepolia)
  if (blueprint.props.verifierContract?.address) {
    console.log(`\nOn-chain verifier: ${blueprint.props.verifierContract.address} (chain ${blueprint.props.verifierContract.chain})`);
    console.log('Verifying on-chain...');
    try {
      const onChainResult = await blueprint.verifyProofOnChain(proof);
      console.log(`On-chain verification: ${onChainResult ? 'PASS' : 'FAIL'}`);
    } catch (err) {
      console.log(`On-chain verification skipped: ${(err as Error).message}`);
    }
  } else {
    console.log('\nNo on-chain verifier deployed yet (expected — deploy in Phase 1R).');
  }
}

main().catch((err) => {
  console.error('Proof generation failed:', err);
  process.exit(1);
});
