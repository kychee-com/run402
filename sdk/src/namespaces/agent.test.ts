/**
 * `r.agent.lightningWallet`: mint waits for the broker and hands the
 * pairing through exactly as the gateway sent it, `get`/`revoke` hit their
 * routes, and a wallet that never leaves `minting` surfaces a typed error.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Client } from "../kernel.js";
import { AgentLightningWallets } from "./agent.js";
import type { AgentLightningWallet } from "./agent.types.js";

function wallet(overrides: Partial<AgentLightningWallet> = {}): AgentLightningWallet {
  return {
    wallet_id: "lw_" + "a".repeat(32),
    status: "active",
    network: "mainnet",
    custody: "run402_hub",
    lightning_address: "run402-7@getalby.com",
    budget_sats: 10_000,
    starter_sats: 1_000,
    has_pairing: true,
    pairing_claimed_at: null,
    failure_reason: null,
    created_at: "2026-09-15T10:00:00Z",
    activated_at: "2026-09-15T10:00:05Z",
    revoked_at: null,
    ...overrides,
  };
}

function client(script: Array<{ method: string; reply: AgentLightningWallet }>): { client: Client; calls: string[] } {
  const calls: string[] = [];
  const fake = {
    async request(path: string, opts: { method?: string }) {
      calls.push(`${opts.method ?? "GET"} ${path}`);
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      assert.equal(opts.method ?? "GET", next.method);
      return next.reply;
    },
  };
  return { client: fake as unknown as Client, calls };
}

describe("agent.lightningWallet", () => {
  it("mints, polls while minting, and returns the pairing the gateway hands out once", async () => {
    const { client: c, calls } = client([
      { method: "POST", reply: wallet({ status: "minting", has_pairing: false }) },
      { method: "GET", reply: wallet({ status: "minting", has_pairing: false }) },
      { method: "GET", reply: wallet({ pairing: "nostr+walletconnect://" + "b".repeat(64) + "?relay=wss%3A%2F%2Fr&secret=" + "c".repeat(64) }) },
    ]);
    const minted = await new AgentLightningWallets(c).mint({ intervalMs: 1, timeoutMs: 1_000 });
    assert.equal(minted.status, "active");
    assert.match(minted.pairing ?? "", /^nostr\+walletconnect:\/\//);
    assert.deepEqual(calls, ["POST /agent/v1/lightning-wallet", "GET /agent/v1/lightning-wallet", "GET /agent/v1/lightning-wallet"]);
  });

  it("returns immediately when the wallet is already active, or when asked not to wait", async () => {
    const active = client([{ method: "POST", reply: wallet() }]);
    assert.equal((await new AgentLightningWallets(active.client).mint()).status, "active");
    const noWait = client([{ method: "POST", reply: wallet({ status: "minting", has_pairing: false }) }]);
    assert.equal((await new AgentLightningWallets(noWait.client).mint({ wait: false })).status, "minting");
  });

  it("gives up with a typed error when the wallet never leaves minting", async () => {
    // A zero budget: the first poll after the mint already sits at the deadline,
    // so the outcome does not depend on the wall clock.
    const { client: c } = client([
      { method: "POST", reply: wallet({ status: "minting" }) },
      { method: "GET", reply: wallet({ status: "minting" }) },
    ]);
    await assert.rejects(new AgentLightningWallets(c).mint({ intervalMs: 1, timeoutMs: 0 }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "LIGHTNING_WALLET_STILL_MINTING");
      return true;
    });
  });

  it("reads and revokes through their routes", async () => {
    const { client: c, calls } = client([
      { method: "GET", reply: wallet() },
      { method: "DELETE", reply: wallet({ status: "revoking" }) },
    ]);
    const wallets = new AgentLightningWallets(c);
    assert.equal((await wallets.get()).status, "active");
    assert.equal((await wallets.revoke()).status, "revoking");
    assert.deepEqual(calls, ["GET /agent/v1/lightning-wallet", "DELETE /agent/v1/lightning-wallet"]);
  });
});
