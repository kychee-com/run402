/**
 * A wallet whose key lives in AWS KMS (spec `wallet-signers`). The key never
 * leaves KMS: the client hashes locally, KMS signs the 32-byte digest, and the
 * DER signature becomes an Ethereum signature with a low-s value (EIP-2) and
 * the recovery id under which it recovers to the wallet's address. A signature
 * that recovers to no address of this wallet is refused before anything
 * carrying it is sent.
 *
 * The algorithm mirrors the gateway's `services/kms-signer.ts`; both keep the
 * same vectors in their tests.
 */
import type { Hex, LocalAccount } from "viem";
import type { WalletSigner } from "../../../core-dist/wallet.js";
import { LocalError } from "../../errors.js";
import { PaidStackUnavailable, loadKmsStack, type KmsStack } from "../_paid-stack.js";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

/** The part of a KMS client the signer uses; tests pass a fake. */
export interface KmsClientLike {
  send(command: unknown): Promise<unknown>;
}

/** KMS answered with something that is not an ECDSA signature. */
function malformed(message: string): LocalError {
  return new LocalError(message, "signing with a KMS wallet", {
    code: "KMS_SIGNATURE_MALFORMED",
    next_actions: [{ type: "retry", why: "Retry once; if it persists, check the key is ECC_SECG_P256K1 / SIGN_VERIFY." }],
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** DER length at `i`: returns [length, next index]. Supports short and long form. */
function derLength(der: Uint8Array, i: number): [number, number] {
  const first = der[i];
  if (first === undefined) throw malformed("malformed DER: truncated length");
  if ((first & 0x80) === 0) return [first, i + 1];
  const count = first & 0x7f;
  if (count === 0 || count > 2 || i + 1 + count > der.length) throw malformed("malformed DER: bad length");
  let len = 0;
  for (let j = 0; j < count; j++) len = (len << 8) | der[i + 1 + j]!;
  return [len, i + 1 + count];
}

/** Parse an ECDSA DER signature (SEQUENCE { INTEGER r, INTEGER s }). */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  if (der[0] !== 0x30) throw malformed("malformed DER signature: not a SEQUENCE");
  let [, i] = derLength(der, 1);
  const readInt = (): bigint => {
    if (der[i] !== 0x02) throw malformed("malformed DER signature: expected INTEGER");
    const [len, start] = derLength(der, i + 1);
    if (len === 0 || start + len > der.length) throw malformed("malformed DER signature: bad INTEGER");
    const value = BigInt("0x" + bytesToHex(der.slice(start, start + len)));
    i = start + len;
    return value;
  };
  const r = readInt();
  const s = readInt();
  if (r === 0n || s === 0n || r >= SECP256K1_N || s >= SECP256K1_N) throw malformed("malformed DER signature: out of range");
  return { r, s };
}

/**
 * KMS's DER signature over `hash` → a 65-byte Ethereum signature that recovers
 * to `address`, or `SIGNER_ADDRESS_MISMATCH`.
 */
export async function derToEthereumSignature(
  viem: Pick<KmsStack["viem"], "recoverAddress" | "serializeSignature" | "numberToHex">,
  der: Uint8Array,
  hash: Hex,
  address: string,
): Promise<Hex> {
  const { r, s } = parseDerSignature(der);
  const lowS = s > SECP256K1_HALF_N ? SECP256K1_N - s : s;
  const rHex = viem.numberToHex(r, { size: 32 });
  const sHex = viem.numberToHex(lowS, { size: 32 });
  const recovered: string[] = [];
  for (const yParity of [0, 1] as const) {
    const signature = viem.serializeSignature({ r: rHex, s: sHex, yParity });
    try {
      const candidate = await viem.recoverAddress({ hash, signature });
      if (candidate.toLowerCase() === address.toLowerCase()) return signature;
      recovered.push(candidate);
    } catch {
      // the other recovery id
    }
  }
  throw new LocalError(
    `The KMS key signed as ${recovered.join(" or ") || "no recoverable address"}, not as this wallet's address ${address}.`,
    "signing with a KMS wallet",
    {
      code: "SIGNER_ADDRESS_MISMATCH",
      details: { expected_address: address, recovered_addresses: recovered },
      next_actions: [{
        type: "edit_request",
        why: "The key behind this wallet's ARN is not the key it was imported from. Re-import the right key, or check wallet.json's key_arn.",
      }],
    },
  );
}

function errorName(err: unknown): string {
  return (err as { name?: unknown })?.name === undefined ? "" : String((err as { name: unknown }).name);
}

/** A KMS/AWS failure as a named local error with its remedy; never renders a credential. */
export function kmsError(err: unknown, signer: WalletSigner, context: string): LocalError {
  if (err instanceof LocalError) return err;
  if (err instanceof PaidStackUnavailable) {
    return new LocalError(
      `A KMS wallet needs ${err.missingPackages.join(", ")}, which is not installed.`,
      context,
      {
        code: "KMS_SIGNER_UNAVAILABLE",
        details: { missing_packages: err.missingPackages },
        next_actions: [{ type: "upgrade_client", command: `npm install ${err.missingPackages.join(" ")}`, why: "Install the KMS client, then retry." }],
      },
    );
  }
  const name = errorName(err);
  const message = err instanceof Error ? err.message : String(err);
  if (name === "AccessDeniedException") {
    const caller = /User: (arn:[^\s]+)/.exec(message)?.[1] ?? null;
    return new LocalError(
      `${caller ?? "This AWS identity"} may not use KMS key ${signer.key_arn}.`,
      context,
      {
        code: "KMS_ACCESS_DENIED",
        details: { key_arn: signer.key_arn, caller_arn: caller },
        next_actions: [{
          type: "authenticate",
          ...(signer.aws_profile ? { command: `aws sso login --profile ${signer.aws_profile}` } : {}),
          why: "Sign in as the identity the key's policy names (for a seller key, that person's SellerSigner session).",
        }],
      },
    );
  }
  const credentials = /CredentialsProviderError|ExpiredToken|UnrecognizedClient|InvalidSignature|TokenProviderError|SSO/i.test(name) ||
    /token (?:has )?expired|sso session|could not load credentials|unable to load credentials|security token included in the request is expired/i.test(message);
  return new LocalError(
    credentials
      ? `The AWS session for KMS key ${signer.key_arn} is missing or expired.`
      : `KMS key ${signer.key_arn} could not be reached (${name || "error"}).`,
    context,
    {
      code: "KMS_SIGNER_UNAVAILABLE",
      details: { key_arn: signer.key_arn, region: signer.region, aws_error: name || null },
      next_actions: credentials
        ? [{
            type: "authenticate",
            command: signer.aws_profile ? `aws sso login --profile ${signer.aws_profile}` : "aws sso login",
            why: "Refresh the AWS session the key is reached through, then retry.",
          }]
        : [{ type: "retry", why: "Retry once KMS is reachable." }],
    },
  );
}

const clients = new Map<string, KmsClientLike>();

/** One KMS client per (region, profile) per process. */
function kmsClient(stack: KmsStack, signer: WalletSigner): KmsClientLike {
  const key = `${signer.region}|${signer.aws_profile ?? ""}`;
  let client = clients.get(key);
  if (!client) {
    client = new stack.KMSClient({ region: signer.region, ...(signer.aws_profile ? { profile: signer.aws_profile } : {}) });
    clients.set(key, client);
  }
  return client;
}

export interface KmsAccountOptions {
  /** Test seam: a stack (or part of one) in place of the lazily loaded peers. */
  stack?: KmsStack;
  client?: KmsClientLike;
}

/** A viem account that signs through `signer` as `address`. */
export async function kmsAccount(signer: WalletSigner, address: string, opts: KmsAccountOptions = {}): Promise<LocalAccount> {
  let stack: KmsStack;
  try {
    stack = opts.stack ?? await loadKmsStack();
  } catch (err) {
    throw kmsError(err, signer, "loading the KMS signer");
  }
  const client = opts.client ?? kmsClient(stack, signer);
  const { viem } = stack;

  const signHash = async (hash: Hex): Promise<Hex> => {
    let der: Uint8Array;
    try {
      const out = await client.send(new stack.SignCommand({
        KeyId: signer.key_arn,
        Message: viem.hexToBytes(hash),
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      })) as { Signature?: Uint8Array };
      if (!out.Signature) throw malformed("KMS returned no signature");
      der = out.Signature;
    } catch (err) {
      throw kmsError(err, signer, "signing with a KMS wallet");
    }
    return derToEthereumSignature(viem, der, hash, address);
  };

  const account = stack.toAccount({
    address: viem.getAddress(address),
    async sign({ hash }) {
      return signHash(hash);
    },
    async signMessage({ message }) {
      return signHash(viem.hashMessage(message));
    },
    async signTypedData(typedData) {
      return signHash(viem.hashTypedData(typedData as Parameters<typeof viem.hashTypedData>[0]));
    },
    async signTransaction(transaction, options) {
      const serializer = (options?.serializer ?? viem.serializeTransaction) as (tx: unknown, signature?: unknown) => Hex | Promise<Hex>;
      // As viem's own local account does: an EIP-4844 transaction is signed without its sidecars.
      const signable = (transaction as { type?: string }).type === "eip4844"
        ? { ...transaction, sidecars: false }
        : transaction;
      const signature = await signHash(viem.keccak256(await serializer(signable)));
      return await serializer(transaction, viem.parseSignature(signature));
    },
  });
  return account as LocalAccount;
}

export interface AdoptedKmsKey {
  address: string;
  key_spec: string;
  key_usage: string;
}

/**
 * Read a KMS key's public key and metadata (read-only: `GetPublicKey` only)
 * and derive its address; `KMS_KEY_UNSUITABLE` unless it is a secp256k1
 * signing key.
 */
export async function adoptKmsKey(signer: WalletSigner, opts: KmsAccountOptions = {}): Promise<AdoptedKmsKey> {
  let stack: KmsStack;
  try {
    stack = opts.stack ?? await loadKmsStack();
  } catch (err) {
    throw kmsError(err, signer, "importing a KMS wallet");
  }
  const client = opts.client ?? kmsClient(stack, signer);
  let out: { PublicKey?: Uint8Array; KeySpec?: string; KeyUsage?: string };
  try {
    out = await client.send(new stack.GetPublicKeyCommand({ KeyId: signer.key_arn })) as typeof out;
  } catch (err) {
    throw kmsError(err, signer, "importing a KMS wallet");
  }
  if (out.KeySpec !== "ECC_SECG_P256K1" || out.KeyUsage !== "SIGN_VERIFY" || !out.PublicKey) {
    throw new LocalError(
      `KMS key ${signer.key_arn} is ${out.KeySpec ?? "unknown"} / ${out.KeyUsage ?? "unknown"}; a wallet needs ECC_SECG_P256K1 / SIGN_VERIFY.`,
      "importing a KMS wallet",
      {
        code: "KMS_KEY_UNSUITABLE",
        details: { key_arn: signer.key_arn, key_spec: out.KeySpec ?? null, key_usage: out.KeyUsage ?? null },
        next_actions: [{ type: "edit_request", why: "Import an asymmetric secp256k1 signing key (ECC_SECG_P256K1, SIGN_VERIFY)." }],
      },
    );
  }
  return { address: addressFromSpki(stack.viem, out.PublicKey), key_spec: out.KeySpec, key_usage: out.KeyUsage };
}

const SECP256K1_SPKI_PREFIX = "3056301006072a8648ce3d020106052b8104000a034200";

/** The EVM address of a secp256k1 SubjectPublicKeyInfo (what KMS GetPublicKey returns). */
export function addressFromSpki(viem: Pick<KmsStack["viem"], "keccak256" | "getAddress">, der: Uint8Array): string {
  const hex = bytesToHex(der);
  if (!hex.startsWith(SECP256K1_SPKI_PREFIX) || hex.length !== SECP256K1_SPKI_PREFIX.length + 130 || hex.slice(SECP256K1_SPKI_PREFIX.length, SECP256K1_SPKI_PREFIX.length + 2) !== "04") {
    throw new LocalError("The KMS public key is not a secp256k1 SubjectPublicKeyInfo with an uncompressed point.", "importing a KMS wallet", {
      code: "KMS_KEY_UNSUITABLE",
      next_actions: [{ type: "edit_request", why: "Import an asymmetric secp256k1 signing key (ECC_SECG_P256K1, SIGN_VERIFY)." }],
    });
  }
  const hash = viem.keccak256(`0x${hex.slice(SECP256K1_SPKI_PREFIX.length + 2)}`);
  return viem.getAddress(`0x${hash.slice(-40)}`);
}

/** Test seam: forget cached clients. */
export function resetKmsClientsForTests(): void {
  clients.clear();
}
