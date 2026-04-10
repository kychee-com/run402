/**
 * R.7 — Benchmark slow-KDF candidates for searchKey computation.
 *
 * searchKey = SlowHash(email || docHash)
 *
 * Target: ~1 second on consumer hardware, ~500ms on server.
 * The parameters chosen here are COMMITTED FOREVER — they become part of
 * the on-chain verification protocol. Changing them later would break
 * existing searchKey lookups.
 *
 * Candidates:
 *   1. argon2id (via hash-wasm — pure WASM, works in Node + browser)
 *   2. scrypt (via hash-wasm — same library)
 *
 * Usage:
 *   npx tsx scripts/research/benchmark-kdf.ts
 */

import { argon2id, scrypt } from 'hash-wasm';
import { performance } from 'node:perf_hooks';
import { createHash, randomBytes } from 'node:crypto';

// ---- Test parameters ----

// Simulated input: email + docHash
const TEST_EMAIL = 'signer@example.com';
const TEST_DOC_HASH = createHash('sha256').update('test document content').digest('hex');
const INPUT = `${TEST_EMAIL}||${TEST_DOC_HASH}`;
const SALT = randomBytes(16); // Fixed salt per (email, docHash) pair in production

// ---- argon2id parameter sets ----
// OWASP 2026 recommends: 128 MiB / 3 iterations
// We test several parameter levels to find the ~1s target on consumer hardware.

const ARGON2_CONFIGS = [
  { label: 'argon2id-64M-3i', memorySize: 65536, iterations: 3, parallelism: 1 },
  { label: 'argon2id-128M-3i', memorySize: 131072, iterations: 3, parallelism: 1 },
  { label: 'argon2id-256M-3i', memorySize: 262144, iterations: 3, parallelism: 1 },
  { label: 'argon2id-256M-4i', memorySize: 262144, iterations: 4, parallelism: 1 },
  { label: 'argon2id-512M-2i', memorySize: 524288, iterations: 2, parallelism: 1 },
  { label: 'argon2id-512M-3i', memorySize: 524288, iterations: 3, parallelism: 1 },
  { label: 'argon2id-384M-3i', memorySize: 393216, iterations: 3, parallelism: 1 },
];

// ---- scrypt parameter sets ----
// N=2^17 (128 MiB), r=8, p=1 is a common recommendation

const SCRYPT_CONFIGS = [
  { label: 'scrypt-N2^15-r8-p1', costFactor: 32768, blockSize: 8, parallelism: 1 },
  { label: 'scrypt-N2^16-r8-p1', costFactor: 65536, blockSize: 8, parallelism: 1 },
  { label: 'scrypt-N2^17-r8-p1', costFactor: 131072, blockSize: 8, parallelism: 1 },
  { label: 'scrypt-N2^18-r8-p1', costFactor: 262144, blockSize: 8, parallelism: 1 },
];

// ---- Benchmark runner ----

async function benchArgon2(config: typeof ARGON2_CONFIGS[0], runs: number = 3): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await argon2id({
      password: INPUT,
      salt: SALT,
      parallelism: config.parallelism,
      iterations: config.iterations,
      memorySize: config.memorySize,
      hashLength: 32,
      outputType: 'hex',
    });
    times.push(performance.now() - t0);
  }
  return times.reduce((a, b) => a + b, 0) / times.length;
}

async function benchScrypt(config: typeof SCRYPT_CONFIGS[0], runs: number = 3): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await scrypt({
      password: INPUT,
      salt: SALT,
      costFactor: config.costFactor,
      blockSize: config.blockSize,
      parallelism: config.parallelism,
      hashLength: 32,
      outputType: 'hex',
    });
    times.push(performance.now() - t0);
  }
  return times.reduce((a, b) => a + b, 0) / times.length;
}

// ---- Main ----

async function main() {
  console.log('=== R.7: Slow-KDF Benchmark ===\n');
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Node.js:  ${process.version}`);
  console.log(`Input:    "${INPUT.slice(0, 40)}..." (${INPUT.length} chars)`);
  console.log(`Salt:     ${SALT.toString('hex')}`);
  console.log(`Runs per config: 3 (averaged)\n`);

  console.log('--- argon2id ---');
  console.log(`${'Config'.padEnd(25)} ${'Avg (ms)'.padStart(10)} ${'Avg (s)'.padStart(10)} ${'Target?'.padStart(10)}`);
  for (const config of ARGON2_CONFIGS) {
    try {
      const avgMs = await benchArgon2(config);
      const inTarget = avgMs >= 500 && avgMs <= 2000;
      console.log(
        `${config.label.padEnd(25)} ${avgMs.toFixed(0).padStart(10)} ${(avgMs / 1000).toFixed(2).padStart(10)} ${(inTarget ? '  YES' : avgMs < 500 ? '  TOO FAST' : '  TOO SLOW').padStart(10)}`
      );
    } catch (err) {
      console.log(`${config.label.padEnd(25)} ${'ERROR'.padStart(10)} — ${(err as Error).message}`);
    }
  }

  console.log('\n--- scrypt ---');
  console.log(`${'Config'.padEnd(25)} ${'Avg (ms)'.padStart(10)} ${'Avg (s)'.padStart(10)} ${'Target?'.padStart(10)}`);
  for (const config of SCRYPT_CONFIGS) {
    try {
      const avgMs = await benchScrypt(config);
      const inTarget = avgMs >= 500 && avgMs <= 2000;
      console.log(
        `${config.label.padEnd(25)} ${avgMs.toFixed(0).padStart(10)} ${(avgMs / 1000).toFixed(2).padStart(10)} ${(inTarget ? '  YES' : avgMs < 500 ? '  TOO FAST' : '  TOO SLOW').padStart(10)}`
      );
    } catch (err) {
      console.log(`${config.label.padEnd(25)} ${'ERROR'.padStart(10)} — ${(err as Error).message}`);
    }
  }

  // Generate one reference hash for verification
  console.log('\n--- Reference hash (argon2id-128M-3i) ---');
  const refHash = await argon2id({
    password: INPUT,
    salt: SALT,
    parallelism: 1,
    iterations: 3,
    memorySize: 131072,
    hashLength: 32,
    outputType: 'hex',
  });
  console.log(`Hash: ${refHash}`);

  console.log('\n=== Recommendation ===');
  console.log('Choose the argon2id config closest to 1000ms on this hardware.');
  console.log('The chosen parameters are committed forever — searchKey breaks if they change.');
  console.log('argon2id is preferred over scrypt (memory-hard, GPU-resistant, OWASP recommended).');
}

main().catch(console.error);
