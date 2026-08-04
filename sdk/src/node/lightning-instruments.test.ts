import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  addConfiguredLightningInstrument,
  listConfiguredLightningInstruments,
  loadConfiguredLightningWallets,
  type LightningInstrumentSecretStore,
} from "./lightning-instruments.js";

const PAYEE = `02${"11".repeat(32)}`;
const CONNECTION = `nostr+walletconnect://${"22".repeat(32)}?relay=${encodeURIComponent("wss://relay.example")}&secret=${"33".repeat(32)}`;

class MemorySecretStore implements LightningInstrumentSecretStore {
  readonly values = new Map<string, string>();
  async put(account: string, value: string) { this.values.set(account, value); }
  async get(account: string) {
    const value = this.values.get(account);
    if (!value) throw new Error("missing");
    return value;
  }
  async delete(account: string) { this.values.delete(account); }
}

describe("Lightning instrument profile storage", () => {
  it("writes only approved metadata and resolves the URI lazily from the credential store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-lightning-instruments-"));
    const metadataPath = join(dir, "lightning-instruments.v1.json");
    const secretStore = new MemorySecretStore();
    const metadata = await addConfiguredLightningInstrument({
      alias: "nwc:deploy-bot",
      connectionUri: CONNECTION,
      network: "mainnet",
      payeeNodePubkeys: [PAYEE],
    }, { metadataPath, profile: "test-profile", secretStore });

    assert.equal(metadata.provider, "alby_hub_lnd_fixed_fee_v1");
    assert.equal(metadata.network, "mainnet");
    const raw = readFileSync(metadataPath, "utf8");
    assert.doesNotMatch(raw, /nostr\+walletconnect|relay\.example|33333333/);
    assert.equal(secretStore.values.get("test-profile:nwc:deploy-bot"), CONNECTION);
    assert.deepEqual(listConfiguredLightningInstruments({ metadataPath }), [metadata]);

    const [adapter] = loadConfiguredLightningWallets({
      metadataPath, profile: "test-profile", secretStore,
    });
    assert.equal(adapter?.alias, "nwc:deploy-bot");
    assert.equal(adapter?.network, "mainnet");
    const prepared = await adapter!.preparePayment({
      invoice: "lnbcrt-placeholder", paymentHash: "44".repeat(32),
      invoiceAmountMsat: 1_000_000, authorizedMaxFeeMsat: 10_000,
    });
    assert.match(prepared.walletRequestId, /^[0-9a-f]{64}$/);
  });
});
