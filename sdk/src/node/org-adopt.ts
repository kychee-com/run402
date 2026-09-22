/** Node-only helpers to adopt the org your wallet's agent owns. */

import { readAllowance } from "../../core-dist/allowance.js";
import { buildSIWxAuthHeaders } from "../../core-dist/allowance-auth.js";
import { getApiBase } from "../../core-dist/config.js";
import { loadLiveControlPlaneSession } from "../../core-dist/control-plane-session.js";
import { LocalError } from "../errors.js";
import type { Run402 } from "../index.js";
import type { AdoptResult } from "../namespaces/org.js";

export interface SignOrgAdoptOptions {
  apiBase?: string;
  allowancePath?: string;
  /** SIWX chain id; defaults to `eip155:84532`. Not pinned by the gateway (only the nonce is action-bound). */
  chainId?: string;
  issuedAt?: string;
  expirationTime?: string;
}

/**
 * Build the `SIGN-IN-WITH-X` wallet proof for an org adopt: a fresh CAIP-122
 * SIWX message carrying the challenge `nonce`, signed by the local allowance.
 * The gateway binds the action/wallet/org/expiry server-side via the nonce, so
 * there is no canonical statement to match (simpler than `signCiDelegation`).
 */
export function signOrgAdopt(nonce: string, opts: SignOrgAdoptOptions = {}): string {
  if (!nonce || typeof nonce !== "string") {
    throw new LocalError("signOrgAdopt requires the challenge nonce", "signing org adopt");
  }
  const allowance = readAllowance(opts.allowancePath);
  if (!allowance || !allowance.address || !allowance.privateKey) {
    throw new LocalError(
      "No local allowance configured. Run `run402 init` or `run402 allowance create` before adopting an org.",
      "signing org adopt",
    );
  }
  const apiBase = opts.apiBase ?? getApiBase();
  const url = new URL("/orgs/v1/adopt", apiBase);
  const now = new Date();
  const headers = buildSIWxAuthHeaders({
    allowance,
    domain: url.hostname,
    uri: url.toString(),
    statement: "Adopt wallet-owned org",
    chainId: opts.chainId ?? "eip155:84532",
    nonce,
    issuedAt: opts.issuedAt ?? now.toISOString(),
    expirationTime: opts.expirationTime ?? new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  });
  return headers["SIGN-IN-WITH-X"];
}

export interface AdoptOrgOptions {
  /**
   * The wallet (0x EVM address) whose agent-owned org to adopt. Defaults to the
   * active allowance address — the proof is always signed by the active wallet,
   * so an override must match the active wallet (select it via `--wallet`).
   */
  wallet?: string;
  /** Org id to adopt — supply only on the second round, after a `select_org` result. */
  orgId?: string;
  /** Optional label to set on the adopted org. `null`/`""` clears. */
  displayName?: string | null;
  /** Override the control-plane session bearer (default: the local live session cache). */
  token?: string;
  apiBase?: string;
  allowancePath?: string;
  controlPlaneSessionPath?: string;
  chainId?: string;
}

/**
 * Run the full org adopt dance (Node): resolve the human's write-capable
 * control-plane session from the local cache, request a challenge, sign the
 * nonce with the active allowance, and submit both proofs. Returns the
 * discriminated {@link AdoptResult} — a `select_org` result is returned, not
 * thrown; re-invoke with `{ orgId }` to adopt a specific org (this re-runs a
 * fresh challenge + signature, which is fine: the nonce is adopt-scoped).
 *
 * Does NOT drive the WebAuthn step-up: a stale session surfaces
 * `StepUpRequiredError` for the caller (CLI) to handle.
 */
export async function adoptOrg(r: Run402, opts: AdoptOrgOptions = {}): Promise<AdoptResult> {
  let token = opts.token;
  if (!token) {
    const session = loadLiveControlPlaneSession(opts.controlPlaneSessionPath);
    if (!session) {
      throw new LocalError(
        "No live control-plane session. Run `run402 operator login --loopback` (write-capable, passkey-fresh) before adopting an org.",
        "adopting org",
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
        "adopting org",
      );
    }
    wallet = allowance.address;
  }

  const challenge = await r.orgs.adopt.challenge({ wallet, token });
  const siwx = signOrgAdopt(challenge.nonce, {
    apiBase: opts.apiBase,
    allowancePath: opts.allowancePath,
    chainId: opts.chainId,
  });
  return r.orgs.adopt.submit({
    token,
    siwx,
    orgId: opts.orgId,
    displayName: opts.displayName,
  });
}
