/**
 * `run402 login [--device] [--no-open]` — sign a person in. See sign-in.mjs.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { fail, reportSdkError } from "./sdk-errors.mjs";
import { getSdk } from "./sdk.mjs";
import { normalizeArgv, hasHelp, assertKnownFlags, positionalArgs } from "./argparse.mjs";
import {
  saveControlPlaneSession,
  controlPlaneSessionFromTokenResponse,
  clearRetiredSessionCaches,
} from "../core-dist/control-plane-session.js";
import { clearApprovals } from "../core-dist/write-approvals.js";
import { openBrowser, pkce, sessionView, startLoopbackServer } from "./sign-in.mjs";

const HELP = `run402 login — sign in as a person (your sign-in session)

Usage:
  run402 login [--no-open]            browser passkey sign-in (full session)
  run402 login --device [--no-open]   device code for a terminal with no browser (read-only)

A person signs in; an agent's wallet is a separate identity ('run402 status').
'run402 login' opens the browser, where you sign in with your passkey, and
catches the redirect on a 127.0.0.1 port. The session it caches can write,
and step-up works on it. 'run402 login --device' prints a code you approve in
the console from any device; that session can only read (every write answers
SESSION_READ_ONLY).

Provisioning, deploying, and writing secrets without a wallet also need a
write approval: 'run402 approve --action <capability> (--org <org_id> |
--project <project_id>)'. From a terminal the CLI opens it for you.

Options:
  --device   Use the device-code flow (RFC 8628) instead of the browser redirect.
  --no-open  Do not open the browser; print the URL only.

Notes:
  - The session is cached at the base config dir, shared across named wallets.
  - JSON to stdout; the URL and code to open go to stderr.
  - 'run402 whoami' shows the session's grade; 'run402 logout' ends it.
`;

const CLIENT_NAME = "run402 CLI";

/** Cache a freshly minted session; a new session invalidates every approval bound to the old one. */
function cacheSession(tokenResponse) {
  const cached = controlPlaneSessionFromTokenResponse(tokenResponse);
  clearApprovals();
  clearRetiredSessionCaches();
  saveControlPlaneSession(cached);
  return cached;
}

/** Best-effort: surface org memberships (auto-redeemed invites land here). Never fails the login. */
async function attachMemberships(view, token) {
  try {
    const who = await getSdk().session.whoami({ token });
    const memberships = Array.isArray(who?.memberships) ? who.memberships : [];
    view.memberships = memberships;
    if (memberships.length) {
      process.stderr.write(
        `Member of ${memberships.length} org(s):\n` +
          memberships.map((m) => `  - ${m.display_name || m.org_id || "unknown"} (${m.role}, ${m.status})`).join("\n") +
          "\n",
      );
    }
  } catch {
    /* best-effort — the session is valid regardless of the whoami result */
  }
}

async function loopbackLogin({ noOpen }) {
  const sdk = getSdk();
  const { codeVerifier, codeChallenge, state, nonce } = pkce();
  const { ready, codePromise, close } = startLoopbackServer({ expectedState: state, timeoutMs: 300_000 });

  let port;
  try {
    port = await ready;
  } catch (err) {
    close();
    return fail({ code: "LOOPBACK_FAILED", message: `Could not start the loopback server: ${err.message}` });
  }
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authorizeUrl = sdk.session.buildCliAuthorizeUrl({ redirectUri, codeChallenge, state, nonce });

  process.stderr.write(`\nTo sign in, open:\n  ${authorizeUrl}\n\n`);
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
    return fail({ code: "LOGIN_FAILED", message: err.message, hint: "Run 'run402 login' to try again." });
  }

  let session;
  try {
    session = await sdk.session.exchangeCliToken({ code, codeVerifier, redirectUri, state });
  } catch (err) {
    close();
    return reportSdkError(err);
  }
  // The loopback server has done its job. Tear it down (destroying any
  // keep-alive socket) so Node's event loop drains and the CLI exits instead
  // of hanging until Ctrl+C.
  close();

  const cached = cacheSession(session);
  process.stderr.write(`\nSigned in (grade: ${cached.grade}).\n`);
  const view = sessionView(cached);
  await attachMemberships(view, session.control_plane_session_token);
  console.log(JSON.stringify(view));
}

async function deviceLogin({ noOpen }) {
  const sdk = getSdk();
  let start;
  try {
    start = await sdk.session.deviceStart();
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
      result = await sdk.session.devicePoll(start.device_code);
    } catch (err) {
      return reportSdkError(err);
    }
    if (result.kind === "approved") {
      const cached = cacheSession(result.session);
      process.stderr.write(`\nSigned in (grade: ${cached.grade}, read-only).\n`);
      const view = sessionView(cached);
      await attachMemberships(view, result.session.control_plane_session_token);
      console.log(JSON.stringify(view));
      return;
    }
    if (result.kind === "authorization_pending") continue;
    if (result.kind === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (result.kind === "access_denied") {
      fail({
        code: "LOGIN_DENIED",
        message: "Authorization was denied in the browser.",
        hint: "Run 'run402 login --device' to try again.",
      });
    }
    if (result.kind === "expired_token") {
      fail({
        code: "LOGIN_EXPIRED",
        message: "The device code expired before approval.",
        hint: "Run 'run402 login --device' to get a fresh code.",
      });
    }
    fail({ code: "LOGIN_FAILED", message: `Unexpected device poll result: ${result.kind}` });
  }
  fail({
    code: "LOGIN_TIMEOUT",
    message: "Timed out waiting for browser approval.",
    hint: "Run 'run402 login --device' to try again.",
  });
}

export async function run(args = []) {
  args = normalizeArgv(args);
  if (hasHelp(args)) {
    console.log(HELP);
    process.exit(0);
  }
  assertKnownFlags(args, ["--help", "-h", "--no-open", "--device"]);
  const extra = positionalArgs(args, []);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for login: ${extra[0]}`, hint: "Use `run402 login [--device] [--no-open]`." });
  }
  const noOpen = args.includes("--no-open");
  if (args.includes("--device")) return deviceLogin({ noOpen });
  return loopbackLogin({ noOpen });
}
