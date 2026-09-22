/**
 * `run402 whoami` — who this CLI acts as: the principal, its org memberships,
 * and the sign-in session (`session.grade`: `browser` | `loopback` | `device`,
 * or `null` for a wallet caller) from `GET /agent/v1/whoami`, plus the write
 * approvals cached on this machine. See sign-in.mjs. `--set-name <name>`
 * sets the principal's display name (`PATCH /agent/v1/me`) and prints the
 * updated identity.
 */

import { fail, reportSdkError } from "./sdk-errors.mjs";
import { getSdk } from "./sdk.mjs";
import { normalizeArgv, hasHelp, assertKnownFlags, flagValue, positionalArgs } from "./argparse.mjs";
import { loadLiveControlPlaneSession, clearControlPlaneSession } from "../core-dist/control-plane-session.js";
import { readApprovals } from "../core-dist/write-approvals.js";

const HELP = `run402 whoami — who this CLI acts as

Usage:
  run402 whoami
  run402 whoami --set-name <name>

Calls GET /agent/v1/whoami. With a live sign-in session ('run402 login') it
reads as that session and reports session.grade: loopback (full), browser, or
device (read-only). Without one it reads as the active wallet and session is
null. The output also lists the write approvals cached on this machine
('run402 approve'), each with its action, target, and expiry.

--set-name <name> sets this principal's display name (PATCH /agent/v1/me,
1-64 characters): the name promotion credit, \`run402 up\`'s room presence,
and audit surfaces show. \`up\` sets a detected default when it is empty. It
is sent with the active wallet, and the output is the updated identity.
For local wallet/profile state use 'run402 status'.
`;

/** Live cached write approvals: action, target, expiry. Never the token. */
function cachedApprovals(nowMs = Date.now()) {
  try {
    return readApprovals()
      .filter((a) => a.expires_at > nowMs)
      .map((a) => ({
        action: a.action,
        org_id: a.org_id ?? null,
        project_id: a.project_id ?? null,
        expires_at: new Date(a.expires_at).toISOString(),
      }));
  } catch {
    return [];
  }
}

export async function run(args = []) {
  args = normalizeArgv(args);
  if (hasHelp(args)) {
    console.log(HELP);
    process.exit(0);
  }
  assertKnownFlags(args, ["--help", "-h", "--set-name"], ["--set-name"]);
  const extra = positionalArgs(args, ["--set-name"]);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for whoami: ${extra[0]}`, hint: "Use `run402 whoami` or `run402 whoami --set-name <name>`." });
  }
  const setName = flagValue(args, "--set-name");
  if (setName !== null && setName.trim() === "") {
    fail({
      code: "BAD_USAGE",
      message: "--set-name must not be empty.",
      details: { field: "--set-name" },
      hint: "Pass a 1-64 character display name.",
    });
  }
  const sdk = getSdk();
  if (setName !== null) {
    try {
      const updated = await sdk.orgs.setDisplayName(setName.trim());
      console.log(JSON.stringify({ ...updated, write_approvals: cachedApprovals() }, null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }
  const session = loadLiveControlPlaneSession();
  let who;
  try {
    who = session
      ? await sdk.session.whoami({ token: session.control_plane_session_token })
      : await sdk.orgs.whoami();
  } catch (err) {
    // A cached session the gateway no longer honours (revoked or expired
    // server-side): drop it so the next command does not replay a dead token.
    if (session && err && err.status === 401) {
      clearControlPlaneSession();
      return fail({
        code: "SESSION_INVALID",
        message: "The cached sign-in session is no longer valid (revoked or expired).",
        hint: "Run 'run402 login' to sign in again.",
        next_actions: [{ type: "authenticate", command: "run402 login" }],
      });
    }
    return reportSdkError(err);
  }
  console.log(JSON.stringify({ ...who, write_approvals: cachedApprovals() }, null, 2));
}
