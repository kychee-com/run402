/** Node-only wallet-owned org claim helpers (v1.82, first-class-orgs). */

import { readAllowance } from "../../core-dist/allowance.js";
import { buildSIWxAuthHeaders } from "../../core-dist/allowance-auth.js";
import { getApiBase } from "../../core-dist/config.js";
import { loadLiveControlPlaneSession } from "../../core-dist/control-plane-session.js";
import { LocalError } from "../errors.js";
import type { Run402 } from "../index.js";
import type { ClaimResult } from "../namespaces/operator.js";

export interface SignWalletOrgClaimOptions {
  apiBase?: string;
  allowancePath?: string;
  /** SIWX chain id; defaults to `eip155:84532`. Not pinned by the gateway (only the nonce is action-bound). */
  chainId?: string;
  issuedAt?: string;
  expirationTime?: string;
}

/**
 * Build the `SIGN-IN-WITH-X` wallet proof for a wallet-org claim: a fresh CAIP-122
 * SIWX message carrying the challenge `nonce`, signed by the local allowance.
 * The gateway binds the action/wallet/org/expiry server-side via the nonce, so
 * there is no canonical statement to match (simpler than `signCiDelegation`).
 */
export function signWalletOrgClaim(nonce: string, opts: SignWalletOrgClaimOptions = {}): string {
  if (!nonce || typeof nonce !== "string") {
    throw new LocalError("signWalletOrgClaim requires the challenge nonce", "signing wallet-org claim");
  }
  const allowance = readAllowance(opts.allowancePath);
  if (!allowance || !allowance.address || !allowance.privateKey) {
    throw new LocalError(
      "No local allowance configured. Run `run402 init` or `run402 allowance create` before claiming a wallet org.",
      "signing wallet-org claim",
    );
  }
  const apiBase = opts.apiBase ?? getApiBase();
  const url = new URL("/agent/v1/operator/claim-wallet-org", apiBase);
  const now = new Date();
  const headers = buildSIWxAuthHeaders({
    allowance,
    domain: url.hostname,
    uri: url.toString(),
    statement: "Claim wallet-owned org",
    chainId: opts.chainId ?? "eip155:84532",
    nonce,
    issuedAt: opts.issuedAt ?? now.toISOString(),
    expirationTime: opts.expirationTime ?? new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  });
  return headers["SIGN-IN-WITH-X"];
}

export interface ClaimWalletOrgOptions {
  /**
   * The wallet (0x EVM address) whose agent-owned org to claim. Defaults to the
   * active allowance address — the proof is always signed by the active wallet,
   * so an override must match the active wallet (select it via `--wallet`).
   */
  wallet?: string;
  /** Org id to claim — supply only on the second round, after a `select_org` result. */
  orgId?: string;
  /** Optional label to set on the claimed org. `null`/`""` clears. */
  displayName?: string | null;
  /** Override the control-plane session bearer (default: the local live session cache). */
  token?: string;
  apiBase?: string;
  allowancePath?: string;
  controlPlaneSessionPath?: string;
  chainId?: string;
}

/**
 * Run the full wallet-org claim dance (Node): resolve the human's write-capable
 * control-plane session from the local cache, request a challenge, sign the
 * nonce with the active allowance, and submit both proofs. Returns the
 * discriminated {@link ClaimResult} — a `select_org` result is returned, not
 * thrown; re-invoke with `{ orgId }` to claim a specific org (this re-runs a
 * fresh challenge + signature, which is fine: the nonce is claim-scoped).
 *
 * Does NOT drive the WebAuthn step-up: a stale session surfaces
 * `StepUpRequiredError` for the caller (CLI) to handle.
 */
export async function claimWalletOrg(r: Run402, opts: ClaimWalletOrgOptions = {}): Promise<ClaimResult> {
  let token = opts.token;
  if (!token) {
    const session = loadLiveControlPlaneSession(opts.controlPlaneSessionPath);
    if (!session) {
      throw new LocalError(
        "No live control-plane session. Run `run402 operator login --loopback` (write-capable, passkey-fresh) before claiming a wallet org.",
        "claiming wallet org",
      );
    }
    token = session.control_plane_session_token;
  }

  let wallet = opts.wallet;
  if (!wallet) {
    const allowance = readAllowance(opts.allowancePath);
    if (!allowance || !allowance.address) {
      throw new LocalError(
        "No wallet specified and no local allowance address found. Pass { wallet } or run `run402 init`.",
        "claiming wallet org",
      );
    }
    wallet = allowance.address;
  }

  const challenge = await r.operator.claimWalletOrg.challenge({ wallet, token });
  const siwx = signWalletOrgClaim(challenge.nonce, {
    apiBase: opts.apiBase,
    allowancePath: opts.allowancePath,
    chainId: opts.chainId,
  });
  return r.operator.claimWalletOrg.submit({
    token,
    siwx,
    orgId: opts.orgId,
    displayName: opts.displayName,
  });
}
