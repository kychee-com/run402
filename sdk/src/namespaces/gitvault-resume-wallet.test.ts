/**
 * `r.gitvault.resume` creates this machine's wallet before the claim
 * (kygit-handoff design D5).
 *
 * The claim route accepts ONLY a SIWX wallet signature, and nothing upstream
 * creates the allowance file for an unpaid request, so a bare machine would
 * answer `AUTH_REQUIRED` without ever touching disk. `resume` creates the
 * keypair itself when the provider supports one and none exists: no faucet,
 * no tier, no payment.
 *
 * These tests drive `resume()` up to its first network call with a mocked
 * fetch (the claim is refused so nothing downstream runs) and assert the
 * allowance calls that happened BEFORE it — same harness as
 * gitvault-resume-errors.test.ts.
 *
 * Run: node --test --import tsx sdk/src/namespaces/gitvault-resume-wallet.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Run402 } from "../index.js";
import type { AllowanceData, CredentialsProvider } from "../credentials.js";

const FABRICATED_KEY = "kgh1_" + "A".repeat(64);
const CLAIM_REFUSAL = { code: "HANDOFF_KEY_ALREADY_CLAIMED", message: "already claimed" };

function mockFetch(): { fetch: typeof globalThis.fetch; order: string[] } {
  const order: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    order.push(`fetch ${String(input).replace(/^https?:\/\/[^/]+/, "")}`);
    return new Response(JSON.stringify(CLAIM_REFUSAL), { status: 409, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetchImpl, order };
}

const CREATED: AllowanceData = { address: "0x" + "ab".repeat(20), privateKey: "0x" + "cd".repeat(32), created: "2026-09-02T00:00:00.000Z", funded: false };

function providerWithAllowance(order: string[], existing: AllowanceData | null): CredentialsProvider {
  return {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject() {
      return null;
    },
    async readAllowance() {
      order.push("readAllowance");
      return existing;
    },
    async createAllowance() {
      order.push("createAllowance");
      return CREATED;
    },
    async saveAllowance(data) {
      order.push(`saveAllowance ${data.address}`);
    },
  };
}

describe("r.gitvault.resume — wallet bootstrap before the claim (design D5)", () => {
  it("a fresh machine (no allowance) gets a keypair created and saved BEFORE the claim POST — no other call in between", async () => {
    const { fetch, order } = mockFetch();
    const lines: string[] = [];
    const r = new Run402({ apiBase: "https://api.example.test", credentials: providerWithAllowance(order, null), fetch });

    // An unscoped keystore_root resolves to the process-wide default
    // (getConfigDir()/gitvault), which every OTHER test in this suite that
    // reaches ensureIdentity() also shares — running the full glob together
    // races two tests writing the SAME identity.json ("identity.json
    // appeared concurrently"). This is the same isolation gap task 5.6 fixed
    // for gitvault.test.ts's compact() calls (gitvault-multi-writer task 5.7).
    await assert.rejects(
      r.gitvault.resume({ key: FABRICATED_KEY, keystore_root: join(tmpdir(), "gitvault-resume-wallet-fresh-ks"), onLine: (l) => lines.push(l) }),
      (err: unknown) => (err as { code?: string }).code === CLAIM_REFUSAL.code,
    );

    assert.equal(order[0], "readAllowance");
    assert.equal(order[1], "createAllowance");
    assert.equal(order[2], `saveAllowance ${CREATED.address}`);
    assert.match(order[3]!, /^fetch \/gitvault\/v1\/handoffs\/.+\/claim$/);
    assert.equal(order.length, 4, "exactly one network call, after the wallet exists");
    // The address is announced (it is public; the private key never is).
    assert.ok(lines.some((l) => l.includes(CREATED.address)), "the created wallet's address is announced on the progress line");
    assert.equal(lines.some((l) => l.includes(CREATED.privateKey)), false, "the private key is never announced");
  });

  it("an existing allowance is left alone — no create, no save", async () => {
    const { fetch, order } = mockFetch();
    const r = new Run402({ apiBase: "https://api.example.test", credentials: providerWithAllowance(order, CREATED), fetch });

    await assert.rejects(
      r.gitvault.resume({ key: FABRICATED_KEY, keystore_root: join(tmpdir(), "gitvault-resume-wallet-existing-ks") }),
      (err: unknown) => (err as { code?: string }).code === CLAIM_REFUSAL.code,
    );

    assert.equal(order[0], "readAllowance");
    assert.match(order[1]!, /^fetch \/gitvault\/v1\/handoffs\/.+\/claim$/);
    assert.equal(order.length, 2);
  });

  it("a provider without allowance support (isomorphic) goes straight to the claim", async () => {
    const { fetch, order } = mockFetch();
    const creds: CredentialsProvider = {
      async getAuth() {
        return { "SIGN-IN-WITH-X": "test-siwx" };
      },
      async getProject() {
        return null;
      },
    };
    const r = new Run402({ apiBase: "https://api.example.test", credentials: creds, fetch });

    await assert.rejects(
      r.gitvault.resume({ key: FABRICATED_KEY, keystore_root: join(tmpdir(), "gitvault-resume-wallet-no-allowance-support-ks") }),
      (err: unknown) => (err as { code?: string }).code === CLAIM_REFUSAL.code,
    );

    assert.equal(order.length, 1);
    assert.match(order[0]!, /^fetch \/gitvault\/v1\/handoffs\/.+\/claim$/);
  });
});
