/**
 * run402 operator — the operator (human / email) session.
 *
 * The operator is YOU, the human, identified by email — distinct from the
 * AGENT (your wallet / SIWX identity). One browser login spans every wallet
 * that verified your email, so `operator overview` returns the cross-wallet
 * union. For a single wallet's account state, use `run402 status`.
 *
 * Auth: browser-delegated device-authorization grant (RFC 8628, the
 * `aws sso login` model). The CLI never performs WebAuthn — the browser does,
 * via the existing magic-link / passkey flows — and the CLI brokers the
 * resulting operator-session token, cached at the BASE config dir (shared
 * across named wallets, since the session is email-scoped).
 *
 * Agent-first: JSON to stdout. `login` additionally prints the verification URL
 * + user code to stderr (human-in-the-loop) and degrades gracefully when not a
 * TTY. Gated on the gateway device-auth bridge (kychee-com/run402-private#443).
 */

import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import { fail, reportSdkError } from "./sdk-errors.mjs";
import { getSdk } from "./sdk.mjs";
import { normalizeArgv, hasHelp, assertKnownFlags } from "./argparse.mjs";
import {
  saveOperatorSession,
  clearOperatorSession,
  loadLiveOperatorSession,
  readOperatorSession,
  isOperatorSessionExpired,
  operatorSessionFromTokenResponse,
} from "../core-dist/operator-session.js";

const CLIENT_NAME = "run402 CLI";

const HELP = `run402 operator — operator (human / email) session

The operator is YOU, the human, identified by email — distinct from the agent
(your wallet). One browser login spans every wallet that verified your email.
For a single wallet's account state, use 'run402 status'.

Usage:
  run402 operator login [--no-open]
  run402 operator overview
  run402 operator whoami
  run402 operator logout

Subcommands:
  login      Sign in via the browser (device-authorization, like 'aws sso login')
  overview   Account view across ALL wallets controlling your email (requires login)
  whoami     Show the cached session (email, wallets, expiry) — local, no network
  logout     Revoke the session server-side and clear the local cache

Options:
  --no-open  (login) Do not auto-open the browser; just print the URL + code.

Notes:
  - The session is cached at the base config dir, shared across named wallets.
  - 'overview' requires 'login' and never falls back to a single wallet.
  - JSON to stdout; 'login' prints the URL + code to stderr (human-in-the-loop).
`;

/** Shared output shape for `whoami` and the `login` success result. */
function sessionView(session, nowMs = Date.now()) {
  return {
    logged_in: true,
    email: session.email,
    wallets: session.wallets,
    wallet_count: session.wallets.length,
    expires_at: new Date(session.expires_at).toISOString(),
    absolute_expires_at: session.absolute_expires_at || null,
    expires_in_seconds: Math.max(0, Math.round((session.expires_at - nowMs) / 1000)),
  };
}

/** Best-effort, cross-platform browser open. Never throws. */
function openBrowser(url) {
  try {
    let cmd;
    let cmdArgs;
    if (process.platform === "darwin") {
      cmd = "open";
      cmdArgs = [url];
    } else if (process.platform === "win32") {
      cmd = "cmd";
      cmdArgs = ["/c", "start", "", url];
    } else {
      cmd = "xdg-open";
      cmdArgs = [url];
    }
    const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // ignore: the URL is also printed to stderr
    child.unref();
  } catch {
    // Best-effort only — the human can always copy the printed URL.
  }
}

async function login(args) {
  assertKnownFlags(args, ["--help", "-h", "--no-open"]);
  const noOpen = args.includes("--no-open");
  const sdk = getSdk();

  let start;
  try {
    start = await sdk.operator.deviceStart({ clientName: CLIENT_NAME });
  } catch (err) {
    return reportSdkError(err);
  }

  // Human-in-the-loop prompt → stderr, so stdout stays clean for the final JSON.
  const target = start.verification_uri_complete || start.verification_uri;
  process.stderr.write(
    `\nTo authorize the ${CLIENT_NAME}, open:\n  ${start.verification_uri}\n` +
      `and enter the code:  ${start.user_code}\n\n`,
  );
  if (!noOpen && process.stderr.isTTY) {
    openBrowser(target);
    process.stderr.write("(opening your browser…)\n\n");
  }
  process.stderr.write("Waiting for approval…\n");

  // Poll loop — honor the server interval, back off on slow_down, and stop at
  // the device-code deadline. if/else (not switch) so the sync scanner doesn't
  // mistake the poll states for CLI subcommands.
  let intervalMs = Math.max(1, Number(start.interval) || 5) * 1000;
  const deadline = Date.now() + Math.max(1, Number(start.expires_in) || 600) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let result;
    try {
      result = await sdk.operator.devicePoll(start.device_code);
    } catch (err) {
      return reportSdkError(err);
    }
    if (result.kind === "approved") {
      const session = operatorSessionFromTokenResponse(result.session);
      saveOperatorSession(session);
      process.stderr.write(`\nSigned in as ${session.email}.\n`);
      console.log(JSON.stringify(sessionView(session)));
      return;
    }
    if (result.kind === "authorization_pending") continue;
    if (result.kind === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (result.kind === "access_denied") {
      fail({
        code: "OPERATOR_LOGIN_DENIED",
        message: "Authorization was denied in the browser.",
        hint: "Run 'run402 operator login' to try again.",
      });
    }
    if (result.kind === "expired_token") {
      fail({
        code: "OPERATOR_LOGIN_EXPIRED",
        message: "The device code expired before approval.",
        hint: "Run 'run402 operator login' to get a fresh code.",
      });
    }
    fail({ code: "OPERATOR_LOGIN_FAILED", message: `Unexpected device poll result: ${result.kind}` });
  }
  fail({
    code: "OPERATOR_LOGIN_TIMEOUT",
    message: "Timed out waiting for browser approval.",
    hint: "Run 'run402 operator login' to try again.",
  });
}

async function logout(args) {
  assertKnownFlags(args, ["--help", "-h"]);
  const session = loadLiveOperatorSession();
  let revoked = false;
  if (session) {
    try {
      await getSdk().operator.revoke({ token: session.operator_session_token });
      revoked = true;
    } catch {
      // Best-effort: a failed server revoke (expired token, offline) must not
      // block clearing the local cache. The local token is removed regardless.
      revoked = false;
    }
  }
  clearOperatorSession();
  console.log(JSON.stringify({ revoked, cleared: true }));
}

async function overview(args) {
  assertKnownFlags(args, ["--help", "-h"]);
  const session = loadLiveOperatorSession();
  if (!session) {
    fail({
      code: "OPERATOR_LOGIN_REQUIRED",
      message: "No operator session. Run 'run402 operator login' to sign in.",
      hint: "operator overview shows the union across all wallets controlling your email; for a single wallet use 'run402 status'.",
    });
  }
  try {
    const result = await getSdk().operator.overview({ token: session.operator_session_token });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    // 401/403 means the session was revoked or expired server-side. Clear the
    // stale cache and point at re-login instead of leaving a dead token behind.
    if (err && (err.status === 401 || err.status === 403)) {
      clearOperatorSession();
      fail({
        code: "OPERATOR_SESSION_INVALID",
        message: "Operator session is no longer valid (revoked or expired).",
        hint: "Run 'run402 operator login' to sign in again.",
      });
    }
    reportSdkError(err);
  }
}

async function whoami(args) {
  assertKnownFlags(args, ["--help", "-h"]);
  const now = Date.now();
  const session = readOperatorSession();
  if (!session) {
    console.log(JSON.stringify({ logged_in: false, reason: "no_session", hint: "Run 'run402 operator login' to sign in." }));
    process.exitCode = 1;
    return;
  }
  if (isOperatorSessionExpired(session, now)) {
    console.log(JSON.stringify({ logged_in: false, reason: "expired", email: session.email, hint: "Run 'run402 operator login' to sign in again." }));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(sessionView(session, now)));
}

export async function run(sub, args = []) {
  args = normalizeArgv(args);
  if (!sub || sub === "--help" || sub === "-h" || hasHelp(args)) {
    console.log(HELP);
    process.exit(0);
  }
  switch (sub) {
    case "login":
      await login(args);
      break;
    case "logout":
      await logout(args);
      break;
    case "overview":
      await overview(args);
      break;
    case "whoami":
      await whoami(args);
      break;
    default:
      fail({
        code: "BAD_USAGE",
        message: `Unknown subcommand: operator ${sub}`,
        hint: "Run 'run402 operator --help' for usage.",
      });
  }
}
