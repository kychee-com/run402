/**
 * `r.repos.resume` creates this machine's wallet before the claim
 * (kygit-handoff design D5).
 *
 * The claim route accepts ONLY a SIWX wallet signature, and nothing upstream
 * creates the wallet file for an unpaid request, so a bare machine would
 * answer `AUTH_REQUIRED` without ever touching disk. `resume` creates the
 * keypair itself when the provider supports one and none exists: no faucet,
 * no tier, no payment.
 *
 * These tests drive `resume()` up to its first network call with a mocked
 * fetch (the claim is refused so nothing downstream runs) and assert the
 * wallet calls that happened BEFORE it — same harness as
 * repos-resume-errors.test.ts.
 *
 * Run: node --test --import tsx sdk/src/namespaces/repos-resume-wallet.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Run402 } from "../index.js";
import type { WalletData, CredentialsProvider } from "../credentials.js";

const FABRICATED_KEY = "kgh1_" + "A".repeat(64);
const CLAIM_REFUSAL = { code: "HANDOFF_KEY_ALREADY_REDEEMED", message: "already claimed" };

function mockFetch(): { fetch: typeof globalThis.fetch; order: string[] } {
  const order: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    order.push(`fetch ${String(input).replace(/^https?:\/\/[^/]+/, "")}`);
    return new Response(JSON.stringify(CLAIM_REFUSAL), { status: 409, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetchImpl, order };
}

const CREATED: WalletData = { address: "0x" + "ab".repeat(20), privateKey: "0x" + "cd".repeat(32), created: "2026-09-02T00:00:00.000Z", funded: false };

function providerWithWallet(order: string[], existing: WalletData | null): CredentialsProvider {
  return {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject() {
      return null;
    },
    async readWallet() {
      order.push("readWallet");
      return existing;
    },
    async createWallet() {
      order.push("createWallet");
      return CREATED;
    },
    async saveWallet(data) {
      order.push(`saveWallet ${data.address}`);
    },
  };
}

describe("r.repos.resume — wallet bootstrap before the claim (design D5)", () => {
  it("a fresh machine (no local wallet) gets a keypair created and saved BEFORE the claim POST — no other call in between", async () => {
    const { fetch, order } = mockFetch();
    const lines: string[] = [];
    const r = new Run402({ apiBase: "https://api.example.test", credentials: providerWithWallet(order, null), fetch });

    // An unscoped keystore_root resolves to the process-wide default
    // (getConfigDir()/vault), which every OTHER test in this suite that
    // reaches ensureIdentity() also shares — running the full glob together
    // races two tests writing the SAME identity.json ("identity.json
    // appeared concurrently"). This is the same isolation gap task 5.6 fixed
    // for repos.test.ts's compact() calls (vault-multi-writer task 5.7).
    await assert.rejects(
      r.repos.resume({ key: FABRICATED_KEY, keystore_root: join(tmpdir(), "vault-resume-wallet-fresh-ks"), onLine: (l) => lines.push(l) }),
      (err: unknown) => (err as { code?: string }).code === CLAIM_REFUSAL.code,
    );

    assert.equal(order[0], "readWallet");
    assert.equal(order[1], "createWallet");
    assert.equal(order[2], `saveWallet ${CREATED.address}`);
    assert.match(order[3]!, /^fetch \/vaults\/v1\/handoffs\/.+\/redeem$/);
    assert.equal(order.length, 4, "exactly one network call, after the wallet exists");
    // The address is announced (it is public; the private key never is).
    assert.ok(lines.some((l) => l.includes(CREATED.address)), "the created wallet's address is announced on the progress line");
    assert.equal(lines.some((l) => l.includes(CREATED.privateKey)), false, "the private key is never announced");
  });

  it("an existing wallet is left alone — no create, no save", async () => {
    const { fetch, order } = mockFetch();
    const r = new Run402({ apiBase: "https://api.example.test", credentials: providerWithWallet(order, CREATED), fetch });

    await assert.rejects(
      r.repos.resume({ key: FABRICATED_KEY, keystore_root: join(tmpdir(), "vault-resume-wallet-existing-ks") }),
      (err: unknown) => (err as { code?: string }).code === CLAIM_REFUSAL.code,
    );

    assert.equal(order[0], "readWallet");
    assert.match(order[1]!, /^fetch \/vaults\/v1\/handoffs\/.+\/redeem$/);
    assert.equal(order.length, 2);
  });

  it("a provider without wallet support (isomorphic) goes straight to the claim", async () => {
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
      r.repos.resume({ key: FABRICATED_KEY, keystore_root: join(tmpdir(), "vault-resume-wallet-no-wallet-support-ks") }),
      (err: unknown) => (err as { code?: string }).code === CLAIM_REFUSAL.code,
    );

    assert.equal(order.length, 1);
    assert.match(order[0]!, /^fetch \/vaults\/v1\/handoffs\/.+\/redeem$/);
  });
});
