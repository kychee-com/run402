/**
 * Shared machinery for a person's command-line sign-in: `run402 login`,
 * `run402 logout`, `run402 whoami`, and `run402 approve`.
 *
 * One sign-in session (wire token class `control_plane_session`), bound to the
 * principal and graded by how it was minted:
 *   - `run402 login` — loopback PKCE (RFC 8252): the browser runs the passkey
 *     ceremony and redirects to a 127.0.0.1 listener. Grade `loopback`: full and
 *     step-up-able.
 *   - `run402 login --device` — RFC 8628 device authorization for a terminal
 *     with no browser. Grade `device`: read-only (every mutation answers
 *     `SESSION_READ_ONLY`).
 *
 * Provisioning, deploying, and writing secrets without a wallet additionally
 * need a **write approval** — passkey-signed, scoped to one (action, target),
 * minted by `run402 approve` and sent as `X-Run402-Write-Approval`. A write
 * approval never satisfies step-up.
 *
 * The session and approvals are cached at the BASE config dir (principal-
 * scoped, shared across named wallets), mode 0600. Agent-first: JSON to stdout;
 * the URL and code a person must open go to stderr.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { fail, reportSdkError } from "./sdk-errors.mjs";
import { getSdk } from "./sdk.mjs";
import { isWriteApprovalRequired } from "#sdk/node";
import { loadLiveControlPlaneSession } from "../core-dist/control-plane-session.js";
import {
  saveApproval,
  hashControlPlaneSession,
  approvalFromTokenResponse,
} from "../core-dist/write-approvals.js";
import { getApiBase } from "../core-dist/config.js";

/** Gateway write-approval capabilities → required target scope. */
export const APPROVAL_ACTIONS = {
  "org.project.create": "org",
  "project.deploy": "project",
  "project.secret.write": "project",
};

/** True when `url` is same-origin as the API base (confirm_url validation). */
function sameApiOrigin(url) {
  try {
    return new URL(url).origin === new URL(getApiBase()).origin;
  } catch {
    return false;
  }
}

/** Best-effort, cross-platform browser open. Never throws. */
export function openBrowser(url) {
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
    // Best-effort only — the person can always copy the printed URL.
  }
}

/** Output shape for a cached sign-in session. NEVER includes the token. */
export function sessionView(session, nowMs = Date.now()) {
  return {
    logged_in: true,
    grade: session.grade,
    read_only: session.grade === "device",
    principal_id: session.principal_id || null,
    amr: session.amr,
    expires_at: new Date(session.expires_at).toISOString(),
    expires_in_seconds: Math.max(0, Math.round((session.expires_at - nowMs) / 1000)),
  };
}

const base64url = (buf) => buf.toString("base64url");

/** Generate PKCE (S256) + CSRF state + replay nonce for the loopback flow. */
export function pkce() {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge, state: base64url(randomBytes(16)), nonce: base64url(randomBytes(16)) };
}

/**
 * Start a 127.0.0.1 loopback server (RFC 8252) that captures exactly one
 * redirect. Returns the bound port (via `ready`), a promise for the auth code,
 * and a `close()`. State is validated here to reject CSRF before exchange.
 */
export function startLoopbackServer({ expectedState, timeoutMs }) {
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
 * Run the write-approval ceremony (loopback + passkey) and cache the minted
 * approval. Requires a live, write-capable sign-in session. Returns the cached
 * approval (or exits non-zero via fail/reportSdkError). Reused by
 * `run402 approve` AND the TTY auto-approve path in provision/deploy.
 */
export async function mintApproval({ action, orgId, projectId, noOpen = false }) {
  const cp = loadLiveControlPlaneSession();
  if (!cp) {
    return fail({
      code: "LOGIN_REQUIRED",
      message: "No sign-in session. Run 'run402 login' first, then approve.",
      hint: "A write approval is minted on top of your sign-in session.",
      next_actions: [{ type: "authenticate", command: "run402 login" }],
    });
  }
  if (cp.grade === "device") {
    return fail({
      code: "SESSION_READ_ONLY",
      message: "This sign-in session came from 'run402 login --device' and can only read; it cannot mint a write approval.",
      hint: "Run 'run402 login' (the browser passkey sign-in), then approve.",
      next_actions: [{ type: "authenticate", command: "run402 login" }],
    });
  }
  const sdk = getSdk();
  const { codeVerifier, codeChallenge, state } = pkce();
  const { ready, codePromise, close } = startLoopbackServer({ expectedState: state, timeoutMs: 300_000 });

  let port;
  try {
    port = await ready;
  } catch (err) {
    close();
    return fail({ code: "APPROVE_FAILED", message: `Could not start the loopback server: ${err.message}` });
  }
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  let challenge;
  try {
    challenge = await sdk.writeApproval.requestChallenge({
      action,
      orgId: orgId ?? undefined,
      projectId: projectId ?? undefined,
      cliRedirectUri: redirectUri,
      codeChallenge,
      state,
      token: cp.control_plane_session_token,
    });
  } catch (err) {
    close();
    return reportSdkError(err);
  }

  const confirmUrl = challenge?.confirm_url;
  if (!confirmUrl || !sameApiOrigin(confirmUrl)) {
    close();
    return fail({
      code: "APPROVE_BAD_CONFIRM_URL",
      message: "The gateway returned a confirm_url that is not same-origin as the API base; aborting.",
    });
  }
  const targetLabel = orgId ? `org ${orgId}` : projectId ? `project ${projectId}` : "(no target)";
  process.stderr.write(
    `\nTo approve '${action}' for ${targetLabel}, open and approve with your passkey:\n  ${confirmUrl}\n\n`,
  );
  if (!noOpen && process.stderr.isTTY) {
    openBrowser(confirmUrl);
    process.stderr.write("(opening your browser…)\n\n");
  }
  process.stderr.write("Waiting for passkey approval…\n");

  let code;
  try {
    code = await codePromise;
  } catch (err) {
    close();
    return fail({ code: "APPROVE_FAILED", message: err.message, hint: "Run 'run402 approve' to try again." });
  }

  let token;
  try {
    token = await sdk.writeApproval.exchangeClaimCode({ code, codeVerifier, state });
  } catch (err) {
    close();
    return reportSdkError(err);
  }
  close();

  const approval = approvalFromTokenResponse(token, {
    action,
    target: { org_id: orgId ?? undefined, project_id: projectId ?? undefined },
    apiOrigin: new URL(getApiBase()).origin,
    controlPlaneSessionHash: hashControlPlaneSession(cp.control_plane_session_token),
    controlPlanePrincipalId: cp.principal_id || "",
  });
  saveApproval(approval);
  process.stderr.write(`\nApproved '${action}' for ${targetLabel}.\n`);
  return approval;
}

/**
 * Run a write action; on `WriteApprovalRequiredError` AND an interactive TTY
 * (CLI), run the scoped approval ceremony and retry once. In MCP / CI /
 * non-TTY the typed error is rethrown unchanged — the agent relays the resolved
 * `run402 approve …` command rather than a browser opening unexpectedly.
 */
export async function withAutoApprove(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isWriteApprovalRequired(err) || !process.stderr.isTTY) throw err;
    const action = err.capability;
    const target = err.target || {};
    if (!action) throw err;
    process.stderr.write(`\nThis '${action}' needs a one-time write approval. Opening the browser to approve…\n`);
    await mintApproval({ action, orgId: target.org_id ?? undefined, projectId: target.project_id ?? undefined });
    return await fn(); // retry once with the now-cached approval
  }
}
