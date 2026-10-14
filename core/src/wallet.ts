import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getWalletPath } from "./config.js";

/**
 * A wallet is backed by exactly one of: a local private key (`privateKey`),
 * or a signer reference (`signer`) naming where the key lives. A signer
 * reference holds no secret.
 */
export interface WalletData {
  address: string;
  /** Local signing key. Absent on a signer-backed wallet. */
  privateKey?: string;
  /** Where a signer-backed wallet's key lives. Absent on a key-backed wallet. */
  signer?: WalletSigner;
  created?: string;
  funded?: boolean;
  lastFaucet?: string;
  rail?: "x402" | "mpp" | "lightning";
  /** The Lightning wallet (`run402 init lightning`): a budgeted wallet on Run402's Hub. `nwc` is the pairing secret. */
  lightning?: WalletLightning;
}

/** An AWS KMS `ECC_SECG_P256K1` / `SIGN_VERIFY` key, adopted by reference. */
export interface WalletSigner {
  kind: "aws_kms";
  key_arn: string;
  region: string;
  /** The AWS profile used to reach the key (an SSO profile); default credential chain when absent. */
  aws_profile?: string;
}

export interface WalletLightning {
  wallet_id: string;
  nwc: string;
  lightning_address: string | null;
  budget_sats: number;
  starter_sats: number;
  custody: "run402_hub";
  minted_at: string;
}

// 0x-prefixed 40-hex EVM address.
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
// 0x-prefixed 64-hex secp256k1 private key (32 bytes).
const PRIVATE_KEY_RE = /^0x[a-fA-F0-9]{64}$/;
// arn:aws:kms:<region>:<account>:key/<id>
export const KMS_KEY_ARN_RE = /^arn:aws[a-z-]*:kms:([a-z0-9-]+):\d{12}:key\/[A-Za-z0-9-]+$/;

/** True when the wallet signs through a signer instead of a local key. */
export function isSignerWallet(wallet: Pick<WalletData, "signer">): wallet is WalletData & { signer: WalletSigner } {
  return wallet.signer !== undefined;
}

/**
 * Load the agent wallet from disk.
 *
 * Returns `null` for the two "no local wallet configured" cases:
 *   - the file does not exist
 *   - the file exists but is not parseable JSON (preserve existing UX —
 *     consumers print "no_wallet" and tell the user to run init)
 *
 * Throws a structured `Error` when the file parses as JSON but the
 * shape is wrong (missing/wrong-type/wrong-length fields). Without this guard
 * downstream callers crash with raw stack traces:
 *   - `cli/lib/status.mjs` reaches for `wallet.address.toLowerCase()`
 *     and crashes with `TypeError: Cannot read properties of undefined`.
 *   - `core/src/wallet-auth.ts` passes a malformed `privateKey` to
 *     `@noble/curves` which throws "expected 32 bytes, got N".
 *
 * The CLI's `cli/lib/config.mjs:readWallet()` wrapper and the Node SDK's
 * `readLocalWallet()` (`sdk/src/node/wallets.ts`) translate the throw into
 * their own structured envelopes (`code: BAD_WALLET_FILE`).
 */
/**
 * If a wallet file is readable by group or other (any of the low 0o077
 * bits set), tighten it to 0600 and warn once on stderr. This self-heals the
 * historical case where a legacy world-readable `wallet.json` (mode 0644) was
 * migrated to `wallet.json` via a mode-preserving rename, leaving the
 * private key exposed on a shared machine. Best-effort: POSIX-only and silent
 * on platforms without meaningful Unix modes (e.g. Windows).
 */
function selfHealPermissions(p: string): void {
  if (process.platform === "win32") return;
  try {
    const mode = statSync(p).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      chmodSync(p, 0o600);
      process.stderr.write(
        `warning: tightened permissions on ${p} from ${mode.toString(8)} to 600 (was readable by other users).\n`,
      );
    }
  } catch {
    // Best-effort; never block a read on a chmod/stat failure.
  }
}

export function readWallet(path?: string): WalletData | null {
  const p = path ?? getWalletPath();
  if (!existsSync(p)) return null;
  selfHealPermissions(p);
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Preserve historical UX — completely unparseable input reads as "no
    // wallet configured" rather than as an error. Consumers already handle
    // null with a friendly "run 'run402 init'" message.
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `wallet.json must contain a JSON object (got ${
        Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed
      }). Back up the file and run 'run402 init' to recreate it.`,
    );
  }
  const data = parsed as Partial<WalletData>;
  if (typeof data.address !== "string" || !ADDRESS_RE.test(data.address)) {
    throw new Error(
      "wallet.json missing valid 'address' (expected 0x-prefixed 40-hex string). " +
        "Back up the file and run 'run402 init' to recreate it.",
    );
  }
  if (data.privateKey !== undefined && data.signer !== undefined) {
    throw new Error(
      `${p} has both 'privateKey' and 'signer'; a wallet is backed by exactly one. ` +
        "Remove the one that does not belong to this wallet.",
    );
  }
  if (data.signer !== undefined) {
    const signer = data.signer as Partial<WalletSigner> | null;
    if (
      !signer || typeof signer !== "object" || signer.kind !== "aws_kms" ||
      typeof signer.key_arn !== "string" || !KMS_KEY_ARN_RE.test(signer.key_arn) ||
      typeof signer.region !== "string" || signer.region.length === 0 ||
      (signer.aws_profile !== undefined && (typeof signer.aws_profile !== "string" || signer.aws_profile.length === 0))
    ) {
      throw new Error(
        `${p} has a malformed 'signer' (expected { kind: "aws_kms", key_arn, region, aws_profile? }). ` +
          "Re-import the wallet with 'run402 wallets import <name> --kms <key-arn>'.",
      );
    }
    return data as WalletData;
  }
  if (typeof data.privateKey !== "string" || !PRIVATE_KEY_RE.test(data.privateKey)) {
    throw new Error(
      "wallet.json missing valid 'privateKey' (expected 0x-prefixed 64-hex string). " +
        "Back up the file and run 'run402 init' to recreate it.",
    );
  }
  return data as WalletData;
}

export function saveWallet(data: WalletData, path?: string): void {
  const p = path ?? getWalletPath();
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.wallet.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}
