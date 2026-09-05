/**
 * one-passkey-per-person: the two proofs a wallet-authenticated notification
 * mutation carries when the human behind this wallet is logged in.
 *
 * `run402 operator login --loopback` caches a passkey-fresh control-plane
 * session. The gateway accepts that session — sent as `Authorization: Bearer`
 * beside the wallet's `SIGN-IN-WITH-X` on the SAME request — as
 * `operator_passkey` assurance for a wallet contact whose verified email the
 * session's principal holds. So a person who logged in once is never asked to
 * enroll a second passkey. With no live cached session this returns
 * `undefined` and the verb behaves exactly as before (wallet auth alone).
 */
import { allowanceAuthHeaders } from "./config.mjs";
import { loadLiveControlPlaneSession } from "../core-dist/control-plane-session.js";

/** `{ siwx, token }` for `path`, or `undefined` when no live operator session is cached. */
export function operatorProofs(path) {
  const siwx = allowanceAuthHeaders(path)["SIGN-IN-WITH-X"];
  const live = loadLiveControlPlaneSession();
  if (!live || !live.control_plane_session_token) return undefined;
  return { siwx, token: live.control_plane_session_token };
}
