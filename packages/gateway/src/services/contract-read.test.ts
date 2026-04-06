import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

let mockReadResult: unknown = null;
let mockShouldThrow: Error | null = null;

mock.module("./contract-read-rpc.js", {
  namedExports: {
    rpcReadContract: async () => {
      if (mockShouldThrow) throw mockShouldThrow;
      return mockReadResult;
    },
  },
});

mock.module("../utils/async-handler.js", {
  namedExports: {
    HttpError: class extends Error { constructor(public statusCode: number, message: string) { super(message); } },
  },
});

const { readContract } = await import("./contract-read.js");

const SIMPLE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

beforeEach(() => {
  mockReadResult = BigInt(1000);
  mockShouldThrow = null;
});

describe("readContract", () => {
  it("happy path: returns the decoded result", async () => {
    const r = await readContract({
      chain: "base-mainnet",
      contractAddress: "0x1111111111111111111111111111111111111111",
      abiFragment: SIMPLE_ABI,
      functionName: "balanceOf",
      args: ["0x2222222222222222222222222222222222222222"],
    });
    assert.equal(r, BigInt(1000));
  });

  it("unsupported chain → 400", async () => {
    await assert.rejects(
      () => readContract({
        chain: "ethereum-mainnet",
        contractAddress: "0x1111111111111111111111111111111111111111",
        abiFragment: SIMPLE_ABI,
        functionName: "balanceOf",
        args: ["0x2222222222222222222222222222222222222222"],
      }),
      /unsupported_chain/,
    );
  });

  it("invalid ABI → 400", async () => {
    await assert.rejects(
      () => readContract({
        chain: "base-mainnet",
        contractAddress: "0x1111111111111111111111111111111111111111",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        abiFragment: "not-an-abi" as any,
        functionName: "balanceOf",
        args: [],
      }),
      /invalid_abi/,
    );
  });

  it("function not in ABI → 400", async () => {
    await assert.rejects(
      () => readContract({
        chain: "base-mainnet",
        contractAddress: "0x1111111111111111111111111111111111111111",
        abiFragment: SIMPLE_ABI,
        functionName: "missingFn",
        args: [],
      }),
      /invalid_abi/,
    );
  });

  it("RPC failure → 502", async () => {
    mockShouldThrow = new Error("RPC went away");
    await assert.rejects(
      () => readContract({
        chain: "base-mainnet",
        contractAddress: "0x1111111111111111111111111111111111111111",
        abiFragment: SIMPLE_ABI,
        functionName: "balanceOf",
        args: ["0x2222222222222222222222222222222222222222"],
      }),
      /rpc_failed|502|RPC/,
    );
  });
});
