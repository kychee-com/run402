import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as viem from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import { Transaction as TempoTransaction } from "viem/tempo";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { saveWallet } from "../../../core-dist/wallet.js";
import { getWalletAuthHeadersAsync } from "../../../core-dist/wallet-auth.js";
import { LocalError } from "../../errors.js";
import { PaidStackUnavailable, type KmsStack } from "../_paid-stack.js";
import {
  adoptKmsKey,
  derToEthereumSignature,
  kmsAccount,
  kmsError,
  parseDerSignature,
  resetKmsClientsForTests,
} from "./kms.js";
import { personalMessageSignerFor, resolveWalletAccount, walletCanSign, walletSignerKind } from "./index.js";

// The fake KMS signs with this key; viem's own account for the same key is the
// reference every KMS-backed signature must equal byte for byte.
const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const reference = privateKeyToAccount(PRIVATE_KEY);
const KEY_ARN = "arn:aws:kms:us-east-1:472210437512:key/11111111-2222-3333-4444-555555555555";
const SIGNER = { kind: "aws_kms" as const, key_arn: KEY_ARN, region: "us-east-1", aws_profile: "kychee-seller" };
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

class SignCommand { constructor(public input: { Message: Uint8Array; KeyId: string; MessageType: string; SigningAlgorithm: string }) {} }
class GetPublicKeyCommand { constructor(public input: { KeyId: string }) {} }
class KMSClient { constructor(public config: unknown) {} send(): Promise<unknown> { throw new Error("unused"); } }

const stack = { KMSClient, SignCommand, GetPublicKeyCommand, viem, toAccount } as unknown as KmsStack;

/** DER-encode (r, s) the way KMS does (minimal INTEGERs with a 0x00 pad when the top bit is set). */
function derEncode(r: bigint, s: bigint): Uint8Array {
  const int = (v: bigint) => {
    let hex = v.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    let bytes = Buffer.from(hex, "hex");
    if (bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const body = Buffer.concat([int(r), int(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/** A KMS client that signs with PRIVATE_KEY; `highS` returns the n - s twin, which KMS may do. */
function fakeKms(opts: { highS?: boolean; publicKey?: Uint8Array; keySpec?: string; keyUsage?: string; fail?: unknown } = {}) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      async send(cmd: unknown) {
        calls.push(cmd);
        if (opts.fail) throw opts.fail;
        if (cmd instanceof SignCommand) {
          assert.equal(cmd.input.MessageType, "DIGEST");
          assert.equal(cmd.input.SigningAlgorithm, "ECDSA_SHA_256");
          assert.equal(cmd.input.KeyId, KEY_ARN);
          const sig = secp256k1.Signature.fromBytes(
            secp256k1.sign(cmd.input.Message, viem.hexToBytes(PRIVATE_KEY), { prehash: false, lowS: true }),
          );
          return { Signature: derEncode(sig.r, opts.highS ? N - sig.s : sig.s) };
        }
        if (cmd instanceof GetPublicKeyCommand) {
          const point = viem.hexToBytes(reference.publicKey);
          const spki = Buffer.concat([Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex"), Buffer.from(point)]);
          return { PublicKey: opts.publicKey ?? spki, KeySpec: opts.keySpec ?? "ECC_SECG_P256K1", KeyUsage: opts.keyUsage ?? "SIGN_VERIFY" };
        }
        throw new Error("unexpected command");
      },
    },
  };
}

beforeEach(() => resetKmsClientsForTests());

describe("DER → Ethereum signature", () => {
  const hash = viem.keccak256(viem.toHex("run402"));

  it("parses short and long INTEGERs, including a 0x00-padded one", () => {
    const { r, s } = parseDerSignature(derEncode(0x80n << 248n, 5n));
    assert.equal(r, 0x80n << 248n);
    assert.equal(s, 5n);
    assert.throws(() => parseDerSignature(Uint8Array.from([0x31, 0x00])));
    assert.throws(() => parseDerSignature(derEncode(0n, 1n)));
  });

  it("turns a high-s signature into the low-s one that recovers to the address", async () => {
    const sig = secp256k1.Signature.fromBytes(secp256k1.sign(viem.hexToBytes(hash), viem.hexToBytes(PRIVATE_KEY), { prehash: false, lowS: true }));
    const fromHigh = await derToEthereumSignature(viem, derEncode(sig.r, N - sig.s), hash, reference.address);
    const fromLow = await derToEthereumSignature(viem, derEncode(sig.r, sig.s), hash, reference.address);
    assert.equal(fromHigh, fromLow);
    assert.equal(await viem.recoverAddress({ hash, signature: fromHigh }), reference.address);
    assert.ok(BigInt(viem.parseSignature(fromHigh).s) <= N / 2n);
  });

  it("refuses with SIGNER_ADDRESS_MISMATCH naming both addresses when the key is not this wallet's", async () => {
    const other = privateKeyToAccount("0x" + "11".repeat(32) as `0x${string}`);
    const sig = secp256k1.Signature.fromBytes(secp256k1.sign(viem.hexToBytes(hash), viem.hexToBytes(PRIVATE_KEY), { prehash: false, lowS: true }));
    await assert.rejects(derToEthereumSignature(viem, derEncode(sig.r, sig.s), hash, other.address), (err: unknown) => {
      assert.ok(err instanceof LocalError);
      assert.equal(err.code, "SIGNER_ADDRESS_MISMATCH");
      const details = err.toJSON().details as { expected_address: string; recovered_addresses: string[] };
      assert.equal(details.expected_address, other.address);
      assert.ok(details.recovered_addresses.includes(reference.address));
      return true;
    });
  });
});

describe("kmsAccount signs exactly as a key-backed account would", () => {
  for (const highS of [false, true]) {
    describe(highS ? "when KMS returns high-s" : "when KMS returns low-s", () => {
      it("personal messages (EIP-191, what SIWX signs)", async () => {
        const account = await kmsAccount(SIGNER, reference.address, { stack, client: fakeKms({ highS }).client });
        assert.equal(account.address, reference.address);
        for (const message of ["Sign in to Run402", "x".repeat(300)]) {
          assert.equal(await account.signMessage({ message }), await reference.signMessage({ message }));
        }
      });

      it("typed data (EIP-712, what x402 authorizations sign)", async () => {
        const account = await kmsAccount(SIGNER, reference.address, { stack, client: fakeKms({ highS }).client });
        const typedData = {
          domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const },
          types: { TransferWithAuthorization: [
            { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
          ] },
          primaryType: "TransferWithAuthorization" as const,
          message: { from: reference.address, to: "0x0000000000000000000000000000000000000001" as const, value: 5_000_000n, validAfter: 0n, validBefore: 9_999_999_999n, nonce: viem.keccak256("0x01") },
        };
        assert.equal(await account.signTypedData(typedData), await reference.signTypedData(typedData));
      });

      it("EIP-1559 transactions", async () => {
        const account = await kmsAccount(SIGNER, reference.address, { stack, client: fakeKms({ highS }).client });
        const tx = { type: "eip1559" as const, chainId: 8453, nonce: 7, to: "0x0000000000000000000000000000000000000001" as const, value: 0n, data: "0x" as const, gas: 60_000n, maxFeePerGas: 2_000_000n, maxPriorityFeePerGas: 1_000n };
        assert.equal(await account.signTransaction(tx), await reference.signTransaction(tx));
      });

      it("Tempo transactions, with Tempo's serializer (what MPP on Tempo signs)", async () => {
        const account = await kmsAccount(SIGNER, reference.address, { stack, client: fakeKms({ highS }).client });
        const tx = {
          type: "tempo" as const, chainId: 4217,
          calls: [{ to: "0x20c0000000000000000000000000000000000000" as const, data: "0x" as const }],
          nonce: 0, gas: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n,
        };
        const serializer = TempoTransaction.serialize as never;
        assert.equal(
          await account.signTransaction(tx as never, { serializer }),
          await reference.signTransaction(tx as never, { serializer }),
        );
      });
    });
  }
});

describe("adoptKmsKey", () => {
  it("derives the address with GetPublicKey only", async () => {
    const kms = fakeKms();
    const adopted = await adoptKmsKey(SIGNER, { stack, client: kms.client });
    assert.equal(adopted.address, reference.address);
    assert.deepEqual(kms.calls.map((c) => c?.constructor.name), ["GetPublicKeyCommand"]);
  });

  it("refuses a key that is not a secp256k1 signing key", async () => {
    for (const [keySpec, keyUsage] of [["ECC_NIST_P256", "SIGN_VERIFY"], ["SYMMETRIC_DEFAULT", "ENCRYPT_DECRYPT"]]) {
      await assert.rejects(adoptKmsKey(SIGNER, { stack, client: fakeKms({ keySpec, keyUsage }).client }), (err: unknown) => {
        assert.equal((err as LocalError).code, "KMS_KEY_UNSUITABLE");
        assert.deepEqual((err as LocalError).toJSON().details, { key_arn: KEY_ARN, key_spec: keySpec, key_usage: keyUsage });
        return true;
      });
    }
  });
});

describe("KMS failures are named with their remedy", () => {
  it("access denied names the key and the caller", async () => {
    const denied = Object.assign(new Error("User: arn:aws:sts::472210437512:assumed-role/AWSReservedSSO_SellerSigner_ab/barry is not authorized to perform: kms:Sign on resource: " + KEY_ARN), { name: "AccessDeniedException" });
    const account = await kmsAccount(SIGNER, reference.address, { stack, client: fakeKms({ fail: denied }).client });
    await assert.rejects(account.signMessage({ message: "hi" }), (err: unknown) => {
      assert.equal((err as LocalError).code, "KMS_ACCESS_DENIED");
      assert.deepEqual((err as LocalError).toJSON().details, { key_arn: KEY_ARN, caller_arn: "arn:aws:sts::472210437512:assumed-role/AWSReservedSSO_SellerSigner_ab/barry" });
      return true;
    });
  });

  it("an expired SSO session names aws sso login for the profile, and renders no credential", () => {
    const expired = Object.assign(new Error("The SSO session associated with this profile has expired. token=SECRETTOKEN"), { name: "CredentialsProviderError" });
    const err = kmsError(expired, SIGNER, "signing");
    assert.equal(err.code, "KMS_SIGNER_UNAVAILABLE");
    const json = JSON.stringify(err.toJSON());
    assert.ok(json.includes("aws sso login --profile kychee-seller"));
    assert.ok(!json.includes("SECRETTOKEN"));
  });

  it("a missing KMS client library names the install command", () => {
    const err = kmsError(new PaidStackUnavailable(["@aws-sdk/client-kms"]), SIGNER, "signing");
    assert.equal(err.code, "KMS_SIGNER_UNAVAILABLE");
    assert.equal((err.toJSON().nextActions as Array<{ command?: string }>)[0]!.command, "npm install @aws-sdk/client-kms");
  });
});

describe("resolveWalletAccount", () => {
  it("classifies wallets without loading anything", () => {
    assert.equal(walletSignerKind({}), "local");
    assert.equal(walletSignerKind({ signer: SIGNER }), "aws_kms");
    assert.equal(walletCanSign({ privateKey: PRIVATE_KEY }), true);
    assert.equal(walletCanSign({ signer: SIGNER }), true);
    assert.equal(walletCanSign({}), false);
  });

  it("a key-backed wallet resolves to its local account; a signer-backed one to KMS", async () => {
    const local = await resolveWalletAccount({ address: reference.address, privateKey: PRIVATE_KEY });
    assert.equal(await local.signMessage({ message: "m" }), await reference.signMessage({ message: "m" }));
    const remote = await resolveWalletAccount({ address: reference.address, signer: SIGNER }, { stack, client: fakeKms().client });
    assert.equal(await remote.signMessage({ message: "m" }), await reference.signMessage({ message: "m" }));
  });

  it("refuses a wallet with both or neither", async () => {
    await assert.rejects(resolveWalletAccount({ address: reference.address, privateKey: PRIVATE_KEY, signer: SIGNER }), /exactly one/);
    await assert.rejects(resolveWalletAccount({ address: reference.address }), /neither/);
  });

  it("SIWX headers from a KMS wallet verify against its address", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-kms-siwx-"));
    try {
      const walletPath = join(dir, "wallet.json");
      saveWallet({ address: reference.address, signer: SIGNER }, walletPath);
      const kms = fakeKms();
      const headers = await getWalletAuthHeadersAsync("/projects/v1", walletPath, (w) => personalMessageSignerFor(w, { stack, client: kms.client }));
      assert.ok(headers);
      const payload = JSON.parse(Buffer.from(headers!["SIGN-IN-WITH-X"], "base64").toString("utf8")) as { address: string; signature: `0x${string}`; domain: string; uri: string; statement: string; nonce: string; issuedAt: string; expirationTime: string; chainId: string };
      assert.equal(payload.address, reference.address);
      const { formatSIWEMessage } = await import("../../../core-dist/wallet-auth.js");
      const message = formatSIWEMessage({ ...payload, chainId: payload.chainId }, payload.address);
      assert.ok(await viem.verifyMessage({ address: reference.address, message, signature: payload.signature }));
      assert.equal(kms.calls.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a KMS wallet sends exactly what a key-backed wallet would", () => {
  for (const [network, chainId] of [["tempo", 4217], ["base", 8453]] as const) {
    it(`on ${network}`, async () => {
      const { sendFromWallet } = await import("../wallets-send.js");
      const raw = async (account: viem.LocalAccount) => {
        const sent: string[] = [];
        const transport = viem.custom({
          async request({ method, params }: { method: string; params?: unknown[] }) {
            switch (method) {
              case "eth_chainId": return viem.numberToHex(chainId);
              case "eth_call": return viem.encodeAbiParameters([{ type: "uint256" }], [10n ** 9n]);
              case "eth_estimateGas": return "0xea60";
              case "eth_maxPriorityFeePerGas": case "eth_gasPrice": return "0x3b9aca00";
              case "eth_getBlockByNumber": return { number: "0x10", baseFeePerGas: "0x3b9aca00", timestamp: "0x6700000", hash: "0x" + "ab".repeat(32), transactions: [] };
              case "eth_getBalance": return viem.numberToHex(10n ** 16n);
              case "eth_getTransactionCount": return "0x0";
              case "eth_blockNumber": return "0x11";
              case "eth_sendRawTransaction": case "eth_sendRawTransactionSync": sent.push(params![0] as string); return viem.keccak256(params![0] as `0x${string}`);
              case "eth_getTransactionReceipt": return { transactionHash: params![0], status: "0x1", blockNumber: "0x10", blockHash: "0x" + "ab".repeat(32), transactionIndex: "0x0", from: reference.address, to: null, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [], logsBloom: "0x" + "00".repeat(256), contractAddress: null, type: "0x2" };
              default: throw new Error(`unmocked ${method}`);
            }
          },
        });
        await sendFromWallet(account, { amount: "0.01", to: "0x000000000000000000000000000000000000dEaD", network, confirm: true }, { transport });
        return sent[0];
      };
      const viaKms = await raw(await kmsAccount(SIGNER, reference.address, { stack, client: fakeKms({ highS: true }).client }));
      assert.ok(viaKms);
      assert.equal(viaKms, await raw(reference));
    });
  }
});
