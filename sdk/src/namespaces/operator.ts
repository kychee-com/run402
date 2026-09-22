/**
 * `operator` namespace — the *human* (email) principal, distinct from the
 * agent's per-wallet SIWX identity.
 *
 * The human authenticates in the browser via an OAuth 2.0 device-authorization
 * grant (RFC 8628, the `aws sso login` model): `deviceStart` returns a
 * user-facing code + URL, the human approves it via the existing magic-link or
 * passkey web flow, and `devicePoll` brokers the resulting operator-session
 * token. `overview` reads the email-union account view with that token, and
 * `revoke` ends the session server-side.
 *
 * Bearer auth is passed explicitly (`opts.token`) rather than sourced from a
 * credential provider, because the operator session is a Node-only on-disk
 * cache (`core/operator-session.ts`) and this namespace stays isomorphic. The
 * `device*` endpoints are unauthenticated (the `device_code` in the body is the
 * credential), so they send no auth headers.
 *
 * Gateway contract: the RFC 8628 device-auth bridge.
 */

import type { Client } from "../kernel.js";
import type { WriteAuthCapability } from "../credentials.js";
import { ApiError, LocalError, NetworkError } from "../errors.js";
import { OperatorSession } from "./operator-session.js";

/** RFC 8628 device-authorization start response. */
export interface DeviceAuthStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** Pre-fills the user_code so the human can click straight through. */
  verification_uri_complete?: string;
  expires_in: number;
  /** Minimum seconds between `devicePoll` calls. */
  interval: number;
}

/** The operator-session token payload (wire shape; relative `expires_in`). */
export interface OperatorSessionToken {
  operator_session_token: string;
  token_type: string;
  expires_in: number;
  absolute_expires_at: string;
  email: string;
  wallets: string[];
}

/**
 * Result of one `devicePoll`. The non-approved states are the RFC 8628 token
 * error codes — they are expected polling states, NOT thrown errors, so callers
 * can run the poll loop without try/catch.
 */
export type DevicePollResult =
  | { kind: "approved"; session: OperatorSessionToken }
  | { kind: "authorization_pending" }
  | { kind: "slow_down" }
  | { kind: "access_denied" }
  | { kind: "expired_token" };

/**
 * Organization overview. Forward-compatible: the gateway owns the exact shape and
 * may add fields, so unknown keys are preserved via the index signature.
 * `scope.kind` is `"email"` for the operator-session (email-union) and
 * `"wallet"` for a SIWX slice.
 */
export interface OperatorOverview {
  scope?: { kind?: "email" | "wallet" | string; principal?: string };
  rollup?: Record<string, unknown>;
  organizations?: unknown[];
  wallets?: unknown[];
  advisories?: unknown[];
  [key: string]: unknown;
}

/**
 * A control-plane session minted by the loopback-PKCE flow
 * (`POST /agent/v1/control-plane/cli/token`). Distinct from the device-flow
 * {@link OperatorSessionToken} (read-only): this carries `provenance` and `amr`.
 * It authorizes most control-plane ops, but `provision` / `deploy` / secrets
 * additionally require a passkey-fresh operator approval (v1.85/v1.87) — see
 * `r.operator.approval`. Forward-compatible.
 */
export interface ControlPlaneSession {
  control_plane_session_token: string;
  token_type?: string;
  /** Relative lifetime in seconds. */
  expires_in?: number;
  /** How it was minted — `loopback_pkce` for the CLI write-login. */
  provenance?: string;
  /** The control-plane principal id. */
  principal_id?: string;
  /** Auth methods satisfied (e.g. `["passkey"]`). */
  amr?: string[];
  [key: string]: unknown;
}

/** Parameters for {@link Operator.buildCliAuthorizeUrl}. */
export interface CliAuthorizeParams {
  /** The CLI's loopback redirect, e.g. `http://127.0.0.1:54321/callback`. */
  redirectUri: string;
  /** PKCE S256 challenge = base64url(sha256(verifier)). */
  codeChallenge: string;
  /** Opaque CSRF state echoed back on the redirect. */
  state: string;
  /** Replay nonce. */
  nonce: string;
}

/** Parameters for {@link Operator.exchangeCliToken}. */
export interface CliTokenExchange {
  /** Authorization code received on the loopback redirect. */
  code: string;
  /** The PKCE verifier whose hash was sent as `codeChallenge`. */
  codeVerifier: string;
  /** Must match the `redirectUri` used at authorize time. */
  redirectUri: string;
  /** Must match the `state` used at authorize time. */
  state: string;
}

const POLL_ERROR_CODES = new Set([
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
]);

// ── Operator approval (write-auth) ceremony (v1.85/v1.87) ─────────────────────
// The passkey-fresh human approval a wallet-less operator mints to provision /
// deploy. Scoped to one (action, target); transport is the X-Run402-Write-Auth
// token. Isomorphic seams — the loopback server + PKCE live in the Node CLI.

/** Input to {@link Approval.requestChallenge}. */
export interface ApprovalChallengeInput {
  /** The capability to approve. Determines whether `orgId` or `projectId` is required. */
  action: WriteAuthCapability;
  /** Required for `org.project.create`. */
  orgId?: string;
  /** Required for `project.deploy` / `project.secret.write`. */
  projectId?: string;
  /** The CLI's loopback redirect, e.g. `http://127.0.0.1:54321/callback`. */
  cliRedirectUri: string;
  /** PKCE S256 challenge = base64url(sha256(verifier)). */
  codeChallenge: string;
  /** Opaque CSRF state echoed back on the loopback redirect. */
  state: string;
  /**
   * The human's control-plane session bearer. Falls back to the client's
   * default auth when omitted — pass it explicitly unless the client was
   * constructed with control-plane-session credentials.
   */
  token?: string;
}

/** Result of {@link Approval.requestChallenge}. Forward-compatible. */
export interface ApprovalChallengeResult {
  challenge_id: string;
  confirm_url: string;
  expires_at?: string;
  action?: string;
  org_id?: string | null;
  project_id?: string | null;
  delivery?: "cli_loopback" | "postmessage" | string;
  [key: string]: unknown;
}

/** Input to {@link Approval.exchangeClaimCode}. */
export interface ApprovalClaimInput {
  /** Authorization code received on the loopback redirect. */
  code: string;
  /** The PKCE verifier whose hash was sent as `codeChallenge`. */
  codeVerifier: string;
  /** Must match the `state` used at challenge time. */
  state: string;
}

/** Minted approval token payload. Expiry lives inside `session` as ISO-8601 strings. Forward-compatible. */
export interface ApprovalTokenResult {
  write_auth_token: string;
  token_type?: string;
  header?: string;
  session?: { expires_at?: string; absolute_expires_at?: string; amr?: string[]; [k: string]: unknown } | null;
  [key: string]: unknown;
}

/**
 * Operator-approval ceremony seams — `r.operator.approval.*`. Isomorphic
 * (raw-request) seams: `requestChallenge` opens a passkey approval scoped to an
 * `(action, target)`; the human approves in the browser; the confirm page
 * redirects to the CLI loopback with a one-time `code`; `exchangeClaimCode`
 * (PKCE) mints the token. The loopback server + PKCE generation live in the
 * Node CLI (`run402 operator approve`).
 */
export class Approval {
  constructor(private readonly client: Client) {}

  /** Begin a scoped approval (`POST …/write-auth/challenges`). Carries the cp-session bearer. */
  async requestChallenge(input: ApprovalChallengeInput): Promise<ApprovalChallengeResult> {
    const body: Record<string, unknown> = {
      action: input.action,
      cli_redirect_uri: input.cliRedirectUri,
      code_challenge: input.codeChallenge,
      state: input.state,
    };
    if (input.orgId !== undefined) body.org_id = input.orgId;
    if (input.projectId !== undefined) body.project_id = input.projectId;
    return this.client.request<ApprovalChallengeResult>(
      "/agent/v1/control-plane/write-auth/challenges",
      {
        method: "POST",
        body,
        ...(input.token
          ? { headers: { Authorization: `Bearer ${input.token}` }, withAuth: false }
          : {}),
        context: "requesting operator approval challenge",
      },
    );
  }

  /**
   * Exchange the loopback claim `code` (+ PKCE verifier + `state`) for the
   * approval token (`POST …/write-auth/cli/token`). No `redirect_uri` — it is
   * bound at challenge time. Unauthenticated (code+verifier are the credential).
   */
  async exchangeClaimCode(input: ApprovalClaimInput): Promise<ApprovalTokenResult> {
    return this.client.request<ApprovalTokenResult>(
      "/agent/v1/control-plane/write-auth/cli/token",
      {
        method: "POST",
        body: { code: input.code, code_verifier: input.codeVerifier, state: input.state },
        withAuth: false,
        context: "exchanging operator approval claim code",
      },
    );
  }
}

export class Operator {
  /**
   * The hosted/browser control-plane **session** surface (gateway v1.78):
   * `r.operator.session.email`, `verifyEmail`, `passkeyVerify`, `whoami`,
   * `refresh`, `revoke`, and the step-up / authenticator helpers.
   * The write-capable human login + step-up + authenticators, distinct from the
   * read-only device/overview methods on this class and the loopback-PKCE
   * CLI write-login below. See {@link OperatorSession}.
   */
  readonly session: OperatorSession;

  /**
   * Operator-approval (write-auth) ceremony: `r.operator.approval.requestChallenge()`
   * + `.exchangeClaimCode()`. The Node CLI (`run402 operator approve`) runs the
   * loopback + PKCE around these isomorphic seams.
   */
  readonly approval: Approval;

  constructor(private readonly client: Client) {
    this.session = new OperatorSession(client);
    this.approval = new Approval(client);
  }

  /**
   * Begin the device-authorization flow. Unauthenticated. Returns the codes the
   * CLI prints (`user_code` + `verification_uri`) plus the poll `interval` and
   * `expires_in`.
   */
  async deviceStart(opts: { clientName?: string } = {}): Promise<DeviceAuthStart> {
    return this.client.request<DeviceAuthStart>("/agent/v1/operator/session/device", {
      method: "POST",
      body: opts.clientName ? { client_name: opts.clientName } : {},
      withAuth: false,
      context: "starting operator device authorization",
    });
  }

  /**
   * Poll once for approval. Bypasses the kernel's error mapping on purpose: the
   * RFC 8628 error codes (`authorization_pending`, `slow_down`, ...) are normal
   * polling states returned as data, not exceptions. Only an unexpected
   * response shape throws.
   */
  async devicePoll(deviceCode: string): Promise<DevicePollResult> {
    const url = `${this.client.apiBase}/agent/v1/operator/session/device/token`;
    let res: Response;
    try {
      res = await this.client.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: deviceCode }),
      });
    } catch (err) {
      throw new NetworkError(
        `Network error while polling operator device token: ${(err as Error).message}`,
        err,
        "polling operator device token",
      );
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && body && typeof body.operator_session_token === "string") {
      return { kind: "approved", session: body as unknown as OperatorSessionToken };
    }
    const error = body && typeof body.error === "string" ? body.error : null;
    if (error && POLL_ERROR_CODES.has(error)) {
      return { kind: error as Exclude<DevicePollResult["kind"], "approved"> };
    }
    throw new ApiError(
      `Unexpected operator device-token response (HTTP ${res.status})`,
      res.status,
      body,
      "polling operator device token",
    );
  }

  /**
   * Fetch the organization overview. With `opts.token` the request carries the
   * operator-session bearer and returns the email-union; without it the request
   * falls back to the credential provider's default auth (SIWX) and returns
   * that wallet's slice. The CLI always passes a token (human-only surface); the
   * SDK supports both because the gateway endpoint accepts both principals.
   */
  async overview(opts: { token?: string } = {}): Promise<OperatorOverview> {
    if (opts.token) {
      return this.client.request<OperatorOverview>("/agent/v1/operator/overview", {
        headers: { Authorization: `Bearer ${opts.token}` },
        withAuth: false,
        context: "fetching operator overview",
      });
    }
    return this.client.request<OperatorOverview>("/agent/v1/operator/overview", {
      context: "fetching operator overview",
    });
  }

  /**
   * Revoke the operator session server-side (the server half of
   * `operator logout`). Idempotent on the gateway; returns 204. The local cache
   * is cleared separately by the CLI.
   */
  async revoke(opts: { token: string }): Promise<void> {
    await this.client.request<unknown>("/agent/v1/operator/session/revoke", {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.token}` },
      withAuth: false,
      context: "revoking operator session",
    });
  }

  // ── Loopback-PKCE write-login (v1.78, RFC 8252 §7.3) ──────────────────────
  // The aws-sso-style write login: the CLI starts a `127.0.0.1` server, opens
  // the browser to the authorize URL (the console runs the passkey ceremony +
  // approves), receives the code on the loopback redirect, then exchanges it
  // here for a write-capable, passkey-fresh control-plane session
  // (`provenance=loopback_pkce`). PKCE generation + the loopback server live in
  // the Node CLI; these two methods are the isomorphic SDK seam.

  /**
   * Build the loopback-PKCE authorize URL the CLI opens in the browser. Pure —
   * no network, no Node APIs — so it is safe in any runtime. The caller
   * generates `codeChallenge`/`state`/`nonce` and runs the redirect server.
   */
  buildCliAuthorizeUrl(params: CliAuthorizeParams): string {
    const q = new URLSearchParams({
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
      state: params.state,
      nonce: params.nonce,
    });
    return `${this.client.apiBase}/agent/v1/control-plane/cli/authorize?${q.toString()}`;
  }

  /**
   * Exchange the loopback authorization code (+ PKCE verifier) for a
   * write-capable {@link ControlPlaneSession}. Unauthenticated — the code +
   * verifier are the credential.
   */
  async exchangeCliToken(params: CliTokenExchange): Promise<ControlPlaneSession> {
    return this.client.request<ControlPlaneSession>("/agent/v1/control-plane/cli/token", {
      method: "POST",
      body: {
        code: params.code,
        code_verifier: params.codeVerifier,
        redirect_uri: params.redirectUri,
        state: params.state,
      },
      withAuth: false,
      context: "exchanging CLI authorization code",
    });
  }
}
