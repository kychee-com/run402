/**
 * KMS-backed named wallets on `@run402/sdk/node` (spec `wallet-signers`,
 * `cli-wallet-profiles`): import by reference writes no secret, `list` /
 * `current` name the signer without contacting it, removal never touches the
 * key, and the sandbox refuses import and send with their CLI commands.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as viem from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import { run402 } from "./index.js";
import type { LocalError } from "../errors.js";
import type { KmsStack } from "./_paid-stack.js";
import { readWallet } from "../../core-dist/wallet.js";

const KEY_ARN = "arn:aws:kms:us-east-1:472210437512:key/11111111-2222-3333-4444-555555555555";
const reference = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

class SignCommand { constructor(public input: unknown) {} }
class GetPublicKeyCommand { constructor(public input: { KeyId: string }) {} }
class KMSClient { constructor(public config: unknown) {} send(): Promise<unknown> { throw new Error("unused"); } }
const stack = { KMSClient, SignCommand, GetPublicKeyCommand, viem, toAccount } as unknown as KmsStack;

function fakeKms(keySpec = "ECC_SECG_P256K1") {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      async send(cmd: unknown) {
        calls.push(cmd);
        const spki = Buffer.concat([Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex"), Buffer.from(viem.hexToBytes(reference.publicKey))]);
        return { PublicKey: spki, KeySpec: keySpec, KeyUsage: "SIGN_VERIFY" };
      },
    },
  };
}

const KEYS = ["RUN402_CONFIG_DIR", "RUN402_WALLET", "RUN402_WALLET_LABEL_SYNC", "RUN402_API_BASE"] as const;
const saved: Record<string, string | undefined> = {};
let configDir: string;

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  configDir = mkdtempSync(join(tmpdir(), "run402-sdk-kms-wallets-"));
  process.env.RUN402_CONFIG_DIR = configDir;
  process.env.RUN402_API_BASE = "https://api.run402.test";
  process.env.RUN402_WALLET_LABEL_SYNC = "0";
  delete process.env.RUN402_WALLET;
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(configDir, { recursive: true, force: true });
});

async function rejectsWith(p: Promise<unknown>, code: string): Promise<LocalError> {
  let caught: unknown;
  await p.catch((e) => { caught = e; });
  assert.equal((caught as LocalError)?.code, code);
  return caught as LocalError;
}

describe("KMS-backed named wallets", () => {
  it("import --kms writes a profile with the signer reference and no secret, reading the key once", async () => {
    const kms = fakeKms();
    const imported = await run402().wallets.import("seller-tal", { kms: { keyId: KEY_ARN, awsProfile: "kychee-seller" } }, { stack, client: kms.client });
    assert.deepEqual(imported, { local_label: "seller-tal", address: reference.address, imported: true, signer: "aws_kms", key_arn: KEY_ARN });
    assert.deepEqual(kms.calls.map((c) => c?.constructor.name), ["GetPublicKeyCommand"]);

    const walletFile = join(configDir, "profiles", "seller-tal", "wallet.json");
    const onDisk = JSON.parse(readFileSync(walletFile, "utf8")) as Record<string, unknown>;
    assert.equal(onDisk.address, reference.address);
    assert.deepEqual(onDisk.signer, { kind: "aws_kms", key_arn: KEY_ARN, region: "us-east-1", aws_profile: "kychee-seller" });
    assert.equal("privateKey" in onDisk, false);
    const meta = JSON.parse(readFileSync(join(configDir, "profiles", "seller-tal", "meta.json"), "utf8")) as Record<string, unknown>;
    assert.equal(meta.signer, "aws_kms");
  });

  it("list and current name the signer without contacting it", async () => {
    const r = run402();
    await r.wallets.import("seller-tal", { kms: { keyId: KEY_ARN } }, { stack, client: fakeKms().client });
    await r.wallets.import("hot", () => "0x" + "22".repeat(32));
    const list = await r.wallets.list();
    assert.deepEqual(Object.fromEntries(list.map((w) => [w.local_label, w.signer])), { "seller-tal": "aws_kms", hot: "local" });
    process.env.RUN402_WALLET = "seller-tal";
    const current = await run402().wallets.current();
    assert.equal(current.signer, "aws_kms");
    assert.equal(current.address, reference.address);
  });

  it("refuses a malformed ARN and an unsuitable key, writing nothing", async () => {
    const r = run402();
    await rejectsWith(r.wallets.import("x", { kms: { keyId: "alias/seller" } }, { stack, client: fakeKms().client }), "BAD_KMS_KEY_ARN");
    await rejectsWith(r.wallets.import("y", { kms: { keyId: KEY_ARN } }, { stack, client: fakeKms("ECC_NIST_P256").client }), "KMS_KEY_UNSUITABLE");
    assert.equal(existsSync(join(configDir, "profiles", "x")), false);
    assert.equal(existsSync(join(configDir, "profiles", "y")), false);
  });

  it("removing a KMS profile deletes the local profile only", async () => {
    const kms = fakeKms();
    const r = run402();
    await r.wallets.import("seller-tal", { kms: { keyId: KEY_ARN } }, { stack, client: kms.client });
    const before = kms.calls.length;
    await r.wallets.remove("seller-tal", { confirm: true });
    assert.equal(existsSync(join(configDir, "profiles", "seller-tal")), false);
    assert.equal(kms.calls.length, before, "no KMS call on removal");
  });

  it("a wallet file with both a key and a signer is refused naming both fields", () => {
    const dir = join(configDir, "profiles", "both");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "wallet.json");
    writeFileSync(file, JSON.stringify({ address: reference.address, privateKey: "0x" + "11".repeat(32), signer: { kind: "aws_kms", key_arn: KEY_ARN, region: "us-east-1" } }));
    assert.throws(() => readWallet(file), /'privateKey' and 'signer'/);
  });
});

describe("the sandbox cannot adopt a signer or move money", () => {
  const sandbox = () => run402({ surface: "sandbox", apiBase: "https://api.run402.test" });

  it("import --kms is refused with the CLI command", async () => {
    const err = await rejectsWith(sandbox().wallets.import("seller-tal", { kms: { keyId: KEY_ARN, awsProfile: "kychee-seller" } }), "SECRET_REQUIRES_CLI");
    assert.equal((err.toJSON().nextActions as Array<{ command: string }>)[0]!.command, `run402 wallets import seller-tal --kms ${KEY_ARN} --aws-profile kychee-seller`);
  });

  it("send is refused before any signature, naming the CLI command", async () => {
    const err = await rejectsWith(sandbox().wallets.send({ amount: "5", to: "0x000000000000000000000000000000000000dEaD" }), "VALUE_TRANSFER_REQUIRES_CLI");
    const actions = err.toJSON().nextActions as Array<{ type: string; command: string }>;
    assert.deepEqual(actions.map((a) => [a.type, a.command]), [["run_cli_command", "run402 wallets send 5 --to 0x000000000000000000000000000000000000dEaD"]]);
  });
});
