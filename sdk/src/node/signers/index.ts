/**
 * The one place a wallet becomes something that signs (spec `wallet-signers`,
 * design D2). A key-backed wallet yields viem's local account; a signer-backed
 * one (`wallet.json` `signer`) yields an account that signs through that
 * signer. Every SDK signing site resolves its signer here, so a signer-backed
 * wallet works wherever a key-backed one does.
 */
import type { LocalAccount } from "viem";
import type { WalletData } from "../../../core-dist/wallet.js";
import type { PersonalMessageSigner } from "../../../core-dist/wallet-auth.js";
import { LocalError } from "../../errors.js";
import { kmsAccount, type KmsAccountOptions } from "./kms.js";

export { adoptKmsKey, kmsAccount, kmsError, type AdoptedKmsKey, type KmsAccountOptions, type KmsClientLike } from "./kms.js";

export type WalletSignerKind = "local" | "aws_kms";

/** How a wallet signs, without loading anything. */
export function walletSignerKind(wallet: Pick<WalletData, "signer">): WalletSignerKind {
  return wallet.signer ? wallet.signer.kind : "local";
}

/** True when the wallet can sign at all (a key or a signer reference). */
export function walletCanSign(wallet: Pick<WalletData, "privateKey" | "signer"> | null | undefined): boolean {
  return Boolean(wallet && (wallet.signer || wallet.privateKey));
}

export interface ResolveWalletAccountOptions extends KmsAccountOptions {
  /** How a key-backed wallet becomes an account (the paid stack passes its own loaded viem). */
  privateKeyToAccount?: (privateKey: `0x${string}`) => unknown;
}

/** The viem account that signs as `wallet`. */
export async function resolveWalletAccount(wallet: WalletData, opts: ResolveWalletAccountOptions = {}): Promise<LocalAccount> {
  if (wallet.privateKey && wallet.signer) {
    throw new LocalError("This wallet has both a private key and a signer; a wallet is backed by exactly one.", "resolving the wallet signer", {
      code: "BAD_WALLET_FILE",
    });
  }
  if (wallet.signer) return kmsAccount(wallet.signer, wallet.address, opts);
  if (wallet.privateKey) {
    const toAccount = opts.privateKeyToAccount ?? (await import("viem/accounts")).privateKeyToAccount;
    return toAccount(wallet.privateKey as `0x${string}`) as LocalAccount;
  }
  throw new LocalError("This wallet has neither a private key nor a signer.", "resolving the wallet signer", {
    code: "BAD_WALLET_FILE",
    next_actions: [{ type: "initialize_wallet", command: "run402 init" }],
  });
}

/** An EIP-191 personal-message signer for `wallet` (SIWX, identity links). */
export async function personalMessageSignerFor(wallet: WalletData, opts: KmsAccountOptions = {}): Promise<PersonalMessageSigner> {
  const account = await resolveWalletAccount(wallet, opts);
  return (message: string) => account.signMessage({ message });
}
