import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Run402 } from "./index.js";
import type { CredentialsProvider, WalletIdentity, AllowanceData } from "./credentials.js";

function makeSdk(creds: Partial<CredentialsProvider>): Run402 {
  const base: CredentialsProvider = {
    async getAuth() { return null; },
    async getProject() { return null; },
    ...creds,
  };
  return new Run402({ apiBase: "https://api.run402.com", credentials: base });
}

describe("Run402.whoami", () => {
  it("returns the wallet identity + active project from the provider", async () => {
    const r = makeSdk({
      async getWalletIdentity(): Promise<WalletIdentity> {
        return { name: "kychon", address: "0xabc", label: "kychon" };
      },
      async getActiveProject() { return "prj_123"; },
    });
    assert.deepEqual(await r.whoami(), {
      local_label: "kychon",
      server_label: "kychon",
      address: "0xabc",
      activeProject: "prj_123",
    });
  });

  it("falls back to readAllowance for address when getWalletIdentity is absent", async () => {
    const r = makeSdk({
      async readAllowance(): Promise<AllowanceData> {
        return { address: "0xdef", privateKey: "0x" + "1".repeat(64) };
      },
    });
    const who = await r.whoami();
    assert.equal(who.address, "0xdef");
    assert.equal(who.local_label, null);
    assert.equal(who.server_label, null);
    assert.equal(who.activeProject, null);
  });

  it("degrades to all-null when the provider implements neither", async () => {
    const r = makeSdk({});
    assert.deepEqual(await r.whoami(), { local_label: null, server_label: null, address: null, activeProject: null });
  });
});
