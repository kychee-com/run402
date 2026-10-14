/**
 * one-passkey-per-person: the two proofs a wallet-authenticated notification
 * mutation carries when the person behind this wallet is signed in.
 *
 * `run402 login` caches a passkey-fresh sign-in session. The gateway accepts
 * that session — sent as `Authorization: Bearer` beside the wallet's
 * `SIGN-IN-WITH-X` on the SAME request — as passkey assurance for a wallet
 * contact whose verified email the session's principal holds. So a person who
 * signed in once is never asked to enroll a second passkey. With no live cached
 * session this returns `undefined` and the verb uses wallet auth alone.
 */
import { walletAuthHeaders, walletFile } from "./config.mjs";
import { loadLiveControlPlaneSession } from "../core-dist/control-plane-session.js";
import { getWalletAuthHeadersAsync } from "../core-dist/wallet-auth.js";
import { personalMessageSignerFor } from "#sdk/node";

/** `{ siwx, token }` for `path`, or `undefined` when no live sign-in session is cached. */
export async function sessionProofs(path) {
  walletAuthHeaders(path); // NO_WALLET when none is configured
  const live = loadLiveControlPlaneSession();
  if (!live || !live.control_plane_session_token) return undefined;
  // A key-backed wallet signs locally; a signer-backed one (KMS) through its signer.
  const headers = await getWalletAuthHeadersAsync(path, walletFile(), (w) => personalMessageSignerFor(w));
  return { siwx: headers["SIGN-IN-WITH-X"], token: live.control_plane_session_token };
}
