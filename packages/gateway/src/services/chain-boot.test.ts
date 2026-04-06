import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockSecretLoader: (key: string) => Promise<string | null>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockQuery: (text: string, params?: any[]) => Promise<{ rows: any[] }>;

const { runChainBootGuards } = await import("./chain-boot.js");

describe("runChainBootGuards", () => {
  beforeEach(() => {
    mockSecretLoader = async (key) => `https://rpc.example.com/${key}`;
    mockQuery = async () => ({ rows: [] });
  });

  it("loads RPC URL for every registered chain", async () => {
    const fetched: string[] = [];
    mockSecretLoader = async (key) => {
      fetched.push(key);
      return "https://rpc";
    };
    await runChainBootGuards({ loadSecret: mockSecretLoader, query: mockQuery });
    assert.ok(fetched.includes("run402/base-mainnet-rpc-url"));
    assert.ok(fetched.includes("run402/base-sepolia-rpc-url"));
  });

  it("fail-fast when an RPC secret is missing, naming the chain", async () => {
    mockSecretLoader = async (key) => (key.includes("mainnet") ? null : "https://rpc");
    await assert.rejects(
      () => runChainBootGuards({ loadSecret: mockSecretLoader, query: mockQuery }),
      /base-mainnet.*missing.*rpc/i,
    );
  });

  it("fail-fast when a wallet row references an unregistered chain", async () => {
    mockQuery = async (text) => {
      if (/contract_wallets/i.test(text)) {
        return { rows: [{ chain: "ethereum-mainnet" }] };
      }
      return { rows: [] };
    };
    await assert.rejects(
      () => runChainBootGuards({ loadSecret: mockSecretLoader, query: mockQuery }),
      /orphaned.*ethereum-mainnet/i,
    );
  });

  it("returns the loaded RPC URL map on success", async () => {
    mockSecretLoader = async (key) => `https://rpc/${key}`;
    const result = await runChainBootGuards({ loadSecret: mockSecretLoader, query: mockQuery });
    assert.equal(
      result["base-mainnet"],
      "https://rpc/run402/base-mainnet-rpc-url",
    );
    assert.equal(
      result["base-sepolia"],
      "https://rpc/run402/base-sepolia-rpc-url",
    );
  });
});
