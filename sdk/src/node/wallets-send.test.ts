import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as viem from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Transaction as TempoTransaction } from "viem/tempo";
import { LocalError } from "../errors.js";
import { parseStablecoinAmount, sendCommand, sendFromWallet, type SendResult } from "./wallets-send.js";

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const TO = "0x000000000000000000000000000000000000dEaD";
const SMART = "0x059D091D51a0f011c9872EaA63Df538F5cE15945";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PATH_USD = "0x20c0000000000000000000000000000000000000";

const SELECTOR = {
  balanceOf: viem.toFunctionSelector("balanceOf(address)"),
  isOwnerAddress: viem.toFunctionSelector("isOwnerAddress(address)"),
};

interface Node {
  chainId: number;
  tokenBalance?: bigint;
  ethBalance?: bigint;
  owner?: boolean;
  receiptStatus?: "0x1" | "0x0";
}

/** A JSON-RPC node good enough for viem to build, sign, send, and confirm one transaction. */
function mockNode(node: Node) {
  const sent: Hex[] = [];
  const calls: string[] = [];
  type Hex = `0x${string}`;
  const word = (v: bigint | boolean) => viem.encodeAbiParameters([{ type: typeof v === "boolean" ? "bool" : "uint256" }], [v as never]);
  const block = { number: "0x10", hash: "0x" + "ab".repeat(32), parentHash: "0x" + "00".repeat(32), timestamp: "0x6700000", baseFeePerGas: "0x3b9aca00", gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], miner: TO, difficulty: "0x0", extraData: "0x", logsBloom: "0x" + "00".repeat(256), nonce: "0x0000000000000000", receiptsRoot: "0x" + "00".repeat(32), sha3Uncles: "0x" + "00".repeat(32), size: "0x1", stateRoot: "0x" + "00".repeat(32), totalDifficulty: "0x0", transactionsRoot: "0x" + "00".repeat(32), uncles: [] };
  const transport = viem.custom({
    async request({ method, params }: { method: string; params?: unknown[] }) {
      calls.push(method);
      switch (method) {
        case "eth_chainId": return viem.numberToHex(node.chainId);
        case "eth_call": {
          const data = (params?.[0] as { data?: string })?.data ?? "";
          if (data.startsWith(SELECTOR.balanceOf)) return word(node.tokenBalance ?? 0n);
          if (data.startsWith(SELECTOR.isOwnerAddress)) return word(node.owner ?? false);
          return "0x";
        }
        case "eth_estimateGas": return "0xea60";
        case "eth_maxPriorityFeePerGas": return "0x3b9aca00";
        case "eth_gasPrice": return "0x3b9aca00";
        case "eth_getBlockByNumber": return block;
        case "eth_blockNumber": return "0x11";
        case "eth_getBalance": return viem.numberToHex(node.ethBalance ?? 0n);
        case "eth_getTransactionCount": return "0x0";
        case "eth_sendRawTransaction":
        case "eth_sendRawTransactionSync": {
          const raw = params![0] as Hex;
          sent.push(raw);
          return viem.keccak256(raw);
        }
        case "eth_getTransactionReceipt": {
          const hash = params![0] as Hex;
          return { transactionHash: hash, status: node.receiptStatus ?? "0x1", blockNumber: "0x10", blockHash: block.hash, transactionIndex: "0x0", from: account.address, to: USDC_BASE, cumulativeGasUsed: "0xea60", gasUsed: "0xea60", effectiveGasPrice: "0x3b9aca00", logs: [], logsBloom: block.logsBloom, contractAddress: null, type: "0x2" };
        }
        default:
          throw new Error(`unmocked RPC method ${method}`);
      }
    },
  });
  return { transport, sent, calls };
}

describe("parseStablecoinAmount", () => {
  it("reads decimal amounts as USD micros", () => {
    assert.equal(parseStablecoinAmount("10"), 10_000_000n);
    assert.equal(parseStablecoinAmount("0.5"), 500_000n);
    assert.equal(parseStablecoinAmount("0.000001"), 1n);
  });

  it("refuses zero, negatives, more than 6 decimals, and text", () => {
    for (const bad of ["0", "-1", "0.0000001", "1e3", "ten", ""]) {
      assert.throws(() => parseStablecoinAmount(bad), (err: unknown) => (err as LocalError).code === "BAD_AMOUNT", bad);
    }
  });
});

describe("sendCommand", () => {
  it("names the CLI command for the sandbox refusal", () => {
    assert.equal(sendCommand({ amount: "5", to: TO }), `run402 wallets send 5 --to ${TO}`);
    assert.equal(sendCommand({ amount: "5", to: TO, network: "tempo" }), `run402 wallets send 5 --to ${TO} --network tempo`);
    assert.equal(sendCommand({ amount: "5; rm -rf /", to: TO }), `run402 wallets send <amount> --to ${TO}`);
  });
});

describe("sendFromWallet on Base", () => {
  it("previews without signing or sending", async () => {
    const node = mockNode({ chainId: 8453, tokenBalance: 20_000_000n, ethBalance: 10n ** 16n });
    const preview = await sendFromWallet(account, { amount: "5", to: TO }, { transport: node.transport });
    assert.deepEqual(preview, {
      preview: true, network: "base", asset: "USDC", amount_usd_micros: 5_000_000,
      from: account.address, to: viem.getAddress(TO), sender: account.address,
      balance_usd_micros: 20_000_000, estimated_gas: 60_000,
    });
    assert.equal(node.sent.length, 0);
  });

  it("sends a USDC transfer from the wallet itself once confirmed, and reports it mined", async () => {
    const node = mockNode({ chainId: 8453, tokenBalance: 20_000_000n, ethBalance: 10n ** 16n });
    const result = await sendFromWallet(account, { amount: "5", to: TO, confirm: true }, { transport: node.transport }) as SendResult;
    assert.equal(node.sent.length, 1);
    const tx = viem.parseTransaction(node.sent[0]!);
    assert.equal(viem.getAddress(tx.to!), USDC_BASE);
    const decoded = viem.decodeFunctionData({ abi: viem.erc20Abi, data: tx.data! });
    assert.equal(decoded.functionName, "transfer");
    assert.deepEqual(decoded.args, [viem.getAddress(TO), 5_000_000n]);
    assert.equal(await viem.recoverTransactionAddress({ serializedTransaction: node.sent[0]! as never }), account.address);
    assert.equal(result.tx_hash, viem.keccak256(node.sent[0]!));
    assert.equal(result.explorer_url, `https://basescan.org/tx/${result.tx_hash}`);
    assert.equal(result.amount_usd_micros, 5_000_000);
  });

  it("sends from an owned smart account through execute", async () => {
    const node = mockNode({ chainId: 8453, tokenBalance: 500_000_000n, ethBalance: 10n ** 16n, owner: true });
    const result = await sendFromWallet(account, { amount: "500", to: TO, from: SMART, confirm: true }, { transport: node.transport }) as SendResult;
    const tx = viem.parseTransaction(node.sent[0]!);
    assert.equal(viem.getAddress(tx.to!), SMART);
    const execute = viem.decodeFunctionData({ abi: viem.parseAbi(["function execute(address target, uint256 value, bytes data)"]), data: tx.data! });
    assert.equal(viem.getAddress(execute.args[0] as string), USDC_BASE);
    assert.equal(execute.args[1], 0n);
    const inner = viem.decodeFunctionData({ abi: viem.erc20Abi, data: execute.args[2] as `0x${string}` });
    assert.deepEqual(inner.args, [viem.getAddress(TO), 500_000_000n]);
    assert.equal(result.from, SMART);
  });

  it("refuses a smart account the wallet does not own, before signing", async () => {
    const node = mockNode({ chainId: 8453, tokenBalance: 500_000_000n, ethBalance: 10n ** 16n, owner: false });
    await assert.rejects(sendFromWallet(account, { amount: "1", to: TO, from: SMART, confirm: true }, { transport: node.transport }), (err: unknown) =>
      (err as LocalError).code === "SMART_ACCOUNT_NOT_OWNER");
    assert.equal(node.sent.length, 0);
  });

  it("names the asset and shortfall when USDC or gas is short", async () => {
    const poor = mockNode({ chainId: 8453, tokenBalance: 1_000_000n, ethBalance: 10n ** 16n });
    await assert.rejects(sendFromWallet(account, { amount: "5", to: TO }, { transport: poor.transport }), (err: unknown) => {
      assert.equal((err as LocalError).code, "SEND_INSUFFICIENT_BALANCE");
      assert.deepEqual((err as LocalError).toJSON().details, { asset: "USDC", address: account.address, needed_usd_micros: 5_000_000, held_usd_micros: 1_000_000, shortfall_usd_micros: 4_000_000 });
      return true;
    });
    const noGas = mockNode({ chainId: 8453, tokenBalance: 20_000_000n, ethBalance: 0n });
    await assert.rejects(sendFromWallet(account, { amount: "5", to: TO }, { transport: noGas.transport }), (err: unknown) =>
      (err as LocalError).code === "SEND_INSUFFICIENT_BALANCE" && ((err as LocalError).toJSON().details as { asset: string }).asset === "ETH");
  });

  it("reports a reverted transaction as a failure carrying its hash", async () => {
    const node = mockNode({ chainId: 8453, tokenBalance: 20_000_000n, ethBalance: 10n ** 16n, receiptStatus: "0x0" });
    await assert.rejects(sendFromWallet(account, { amount: "5", to: TO, confirm: true }, { transport: node.transport }), (err: unknown) => {
      assert.equal((err as LocalError).code, "SEND_REVERTED");
      assert.equal(((err as LocalError).toJSON().details as { tx_hash: string }).tx_hash, viem.keccak256(node.sent[0]!));
      return true;
    });
  });
});

describe("sendFromWallet on Tempo", () => {
  it("sends pathUSD as a Tempo transaction whose fee is paid in pathUSD", async () => {
    const node = mockNode({ chainId: 4217, tokenBalance: 1_000_000n });
    const result = await sendFromWallet(account, { amount: "0.01", to: TO, network: "tempo", confirm: true }, { transport: node.transport }) as SendResult;
    assert.equal(node.sent.length, 1);
    const tx = TempoTransaction.deserialize(node.sent[0]! as never) as unknown as { chainId: number; feeToken?: string; calls: Array<{ to: string; data: `0x${string}` }> };
    assert.equal(tx.chainId, 4217);
    assert.equal(tx.feeToken?.toLowerCase(), PATH_USD);
    assert.equal(tx.calls.length, 1);
    assert.equal(tx.calls[0]!.to.toLowerCase(), PATH_USD);
    const inner = viem.decodeFunctionData({ abi: viem.erc20Abi, data: tx.calls[0]!.data });
    assert.deepEqual(inner.args, [viem.getAddress(TO), 10_000n]);
    assert.equal(result.network, "tempo");
    assert.equal(result.asset, "pathUSD");
  });

  it("counts the fee against the same pathUSD balance", async () => {
    const node = mockNode({ chainId: 4217, tokenBalance: 10_000n });
    await assert.rejects(sendFromWallet(account, { amount: "0.01", to: TO, network: "tempo" }, { transport: node.transport }), (err: unknown) =>
      (err as LocalError).code === "SEND_INSUFFICIENT_BALANCE" && ((err as LocalError).toJSON().details as { asset: string }).asset === "pathUSD");
  });

  it("does not send from a smart account on Tempo", async () => {
    const node = mockNode({ chainId: 4217, tokenBalance: 10n ** 9n });
    await assert.rejects(sendFromWallet(account, { amount: "1", to: TO, from: SMART, network: "tempo" }, { transport: node.transport }), (err: unknown) =>
      (err as LocalError).code === "SEND_FROM_UNSUPPORTED");
  });
});
