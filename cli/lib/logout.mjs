/**
 * `run402 logout` — end the sign-in session server-side and clear the local
 * session and write-approval caches. See sign-in.mjs.
 */

import { fail } from "./sdk-errors.mjs";
import { getSdk } from "./sdk.mjs";
import { normalizeArgv, hasHelp, assertKnownFlags, positionalArgs } from "./argparse.mjs";
import {
  loadLiveControlPlaneSession,
  clearControlPlaneSession,
  clearRetiredSessionCaches,
} from "../core-dist/control-plane-session.js";
import { clearApprovals } from "../core-dist/write-approvals.js";

const HELP = `run402 logout — end your sign-in session

Usage:
  run402 logout

Revokes the cached sign-in session on the gateway, then deletes it and every
cached write approval from this machine. The local cache is cleared even when
the revoke cannot reach the gateway. A wallet is not affected.
`;

export async function run(args = []) {
  args = normalizeArgv(args);
  if (hasHelp(args)) {
    console.log(HELP);
    process.exit(0);
  }
  assertKnownFlags(args, ["--help", "-h"]);
  const extra = positionalArgs(args, []);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for logout: ${extra[0]}`, hint: "Use `run402 logout`." });
  }
  const session = loadLiveControlPlaneSession();
  let revoked = false;
  if (session) {
    try {
      await getSdk().session.revoke({ token: session.control_plane_session_token });
      revoked = true;
    } catch {
      // Best-effort: a failed server revoke (expired token, offline) must not
      // block clearing the local cache. The local token is removed regardless.
      revoked = false;
    }
  }
  clearControlPlaneSession();
  clearApprovals();
  clearRetiredSessionCaches();
  console.log(JSON.stringify({ revoked, cleared: true }));
}
