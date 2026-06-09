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
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
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
import {
  saveControlPlaneSession,
  clearControlPlaneSession,
  readControlPlaneSession,
  isControlPlaneSessionExpired,
  controlPlaneSessionFromTokenResponse,
} from "../core-dist/control-plane-session.js";

const CLIENT_NAME = "run402 CLI";

const HELP = `run402 operator — operator (human / email) session

The operator is YOU, the human, identified by email — distinct from the agent
(your wallet). One browser login spans every wallet that verified your email.
For a single wallet's account state, use 'run402 status'.

Usage:
  run402 operator login [--no-open]              (read session, device-flow)
  run402 operator login --loopback [--no-open]   (write session, loopback-PKCE)
  run402 operator login --step-up                (fresh write session for high-stakes ops)
  run402 operator overview
  run402 operator whoami
  run402 operator logout

Subcommands:
  login      Sign in via the browser. Default = device-flow READ session (powers
             'overview'). --loopback = write-capable control-plane session
             (aws-sso-style, passkey-fresh). --step-up = re-mint a fresh write session.
  overview   Account view across ALL wallets controlling your email (requires login)
  whoami     Show the cached session(s) — local, no network
  logout     Revoke the session server-side and clear the local cache(s)

Options:
  --no-open  (login) Do not auto-open the browser; just print the URL.
  --loopback (login) Use the loopback-PKCE write login instead of the device flow.
  --step-up  (login) Re-mint a fresh write session (implies --loopback).

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

/** Output shape for the write (control-plane) session. NEVER includes the token. */
function controlPlaneView(session, nowMs = Date.now()) {
  return {
    logged_in: true,
    kind: "control_plane_session",
    provenance: session.provenance,
    principal_id: session.principal_id || null,
    amr: session.amr,
    expires_at: new Date(session.expires_at).toISOString(),
    expires_in_seconds: Math.max(0, Math.round((session.expires_at - nowMs) / 1000)),
    write_capable: true,
  };
}

const base64url = (buf) => buf.toString("base64url");

/** Generate PKCE (S256) + CSRF state + replay nonce for the loopback flow. */
function pkce() {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge, state: base64url(randomBytes(16)), nonce: base64url(randomBytes(16)) };
}

/**
 * Start a 127.0.0.1 loopback server (RFC 8252) that captures exactly one
 * redirect. Returns the bound port (via `ready`), a promise for the auth code,
 * and a `close()`. State is validated here to reject CSRF before exchange.
 */
function startLoopbackServer({ expectedState, timeoutMs }) {
  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  let timer;
  // Track live sockets: server.close() alone stops NEW connections but leaves
  // the browser's keep-alive socket open, which keeps Node's event loop alive
  // and hangs the CLI after a successful login. close() must destroy them.
  const sockets = new Set();
  const server = createServer((req, res) => {
    let u;
    try {
      u = new URL(req.url, "http://127.0.0.1");
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }
    if (u.pathname !== "/callback") {
      res.writeHead(404).end("not found");
      return;
    }
    const code = u.searchParams.get("code");
    const gotState = u.searchParams.get("state");
    const errParam = u.searchParams.get("error");
    // `connection: close` so the browser does not keep the socket alive.
    res.writeHead(200, { "content-type": "text/html", connection: "close" });
    res.end(
      "<!doctype html><html><body style=\"font-family:system-ui;padding:3rem\">" +
        "<h2>run402 - you're signed in.</h2><p>You can close this window and return to your terminal.</p></body></html>",
    );
    // Do NOT tear down here — let the response flush. The caller calls close()
    // once it has the code (or on any failure path).
    if (errParam) rejectCode(new Error(`authorization error: ${errParam}`));
    else if (!code) rejectCode(new Error("no authorization code on the loopback redirect"));
    else if (gotState !== expectedState) rejectCode(new Error("state mismatch on the loopback redirect (possible CSRF) - aborted"));
    else resolveCode(code);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  function close() {
    clearTimeout(timer);
    for (const s of sockets) {
      try {
        s.destroy();
      } catch {
        // already gone
      }
    }
    try {
      server.close();
    } catch {
      // already closing
    }
  }
  timer = setTimeout(() => {
    close();
    rejectCode(new Error("timed out waiting for browser approval"));
  }, timeoutMs);
  server.on("error", (e) => {
    close();
    rejectCode(e);
  });
  const ready = new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res(server.address().port));
  });
  return { ready, codePromise, close };
}

/**
 * Loopback-PKCE write-login (RFC 8252, the aws-sso-style flow). Mints a
 * write-capable control-plane session via the browser passkey ceremony, caches
 * it (mode 0600), and prints metadata only - never the token.
 */
async function loopbackLogin(args, { stepUp }) {
  const noOpen = args.includes("--no-open");
  const sdk = getSdk();
  const { codeVerifier, codeChallenge, state, nonce } = pkce();
  const { ready, codePromise, close } = startLoopbackServer({ expectedState: state, timeoutMs: 300_000 });

  let port;
  try {
    port = await ready;
  } catch (err) {
    close();
    return fail({ code: "OPERATOR_LOOPBACK_FAILED", message: `Could not start the loopback server: ${err.message}` });
  }
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authorizeUrl = sdk.operator.buildCliAuthorizeUrl({ redirectUri, codeChallenge, state, nonce });

  process.stderr.write(
    `\nTo ${stepUp ? "re-authenticate (step-up)" : "sign in (write-capable)"}, open:\n  ${authorizeUrl}\n\n`,
  );
  if (!noOpen && process.stderr.isTTY) {
    openBrowser(authorizeUrl);
    process.stderr.write("(opening your browser…)\n\n");
  }
  process.stderr.write("Waiting for approval…\n");

  let code;
  try {
    code = await codePromise;
  } catch (err) {
    close();
    return fail({
      code: "OPERATOR_LOGIN_FAILED",
      message: err.message,
      hint: "Run 'run402 operator login --loopback' to try again.",
    });
  }

  let session;
  try {
    session = await sdk.operator.exchangeCliToken({ code, codeVerifier, redirectUri, state });
  } catch (err) {
    close();
    return reportSdkError(err);
  }
  // The loopback server has done its job. Tear it down (destroying any
  // keep-alive socket) so Node's event loop drains and the CLI exits instead
  // of hanging until Ctrl+C.
  close();

  const cached = controlPlaneSessionFromTokenResponse(session);
  saveControlPlaneSession(cached);
  process.stderr.write(`\nSigned in (write-capable, provenance=${cached.provenance}).\n`);

  // Surface org memberships — newly-active rows are invites auto-claimed at this
  // login (owner/admin invites only claim once a passkey is enrolled). Best-effort:
  // login already succeeded, so a whoami hiccup must not fail the command.
  const view = controlPlaneView(cached);
  try {
    const who = await sdk.operator.session.whoami({ token: session.control_plane_session_token });
    const memberships = Array.isArray(who?.memberships) ? who.memberships : [];
    view.memberships = memberships;
    if (memberships.length) {
      process.stderr.write(
        `Member of ${memberships.length} org(s):\n` +
          memberships.map((m) => `  - ${m.billing_account_id} (${m.role}, ${m.status})`).join("\n") +
          "\n",
      );
    }
  } catch {
    /* best-effort — the session is valid regardless of the whoami result */
  }
  console.log(JSON.stringify(view));
}

async function login(args) {
  assertKnownFlags(args, ["--help", "-h", "--no-open", "--loopback", "--device", "--step-up"]);
  // Loopback-PKCE = the write-capable control-plane login (--loopback/--step-up).
  // The default stays the device-flow READ session (which powers 'overview');
  // --device forces it explicitly.
  if (args.includes("--loopback") || args.includes("--step-up")) {
    return loopbackLogin(args, { stepUp: args.includes("--step-up") });
  }
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
  clearControlPlaneSession();
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
  const cp = readControlPlaneSession();
  const liveCp = cp && !isControlPlaneSessionExpired(cp, now) ? cp : null;

  if (session && !isOperatorSessionExpired(session, now)) {
    const view = sessionView(session, now);
    if (liveCp) view.control_plane = controlPlaneView(liveCp, now);
    console.log(JSON.stringify(view));
    return;
  }
  // No live device-flow READ session — fall back to the write session if present.
  if (liveCp) {
    console.log(JSON.stringify(controlPlaneView(liveCp, now)));
    return;
  }
  if (!session) {
    console.log(JSON.stringify({ logged_in: false, reason: "no_session", hint: "Run 'run402 operator login' to sign in." }));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ logged_in: false, reason: "expired", email: session.email, hint: "Run 'run402 operator login' to sign in again." }));
  process.exitCode = 1;
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
