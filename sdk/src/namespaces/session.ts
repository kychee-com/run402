/**
 * `session` — a person's **sign-in session** (wire token class
 * `control_plane_session`). One session, bound to the principal, graded by how
 * it was minted (`grade` on every mint response and on `GET /agent/v1/whoami`):
 *
 * - `browser` — the console: email magic link, passkey, Google, or GitHub.
 * - `loopback` — `run402 login`: the loopback-PKCE browser ceremony
 *   ({@link Session.buildCliAuthorizeUrl} + {@link Session.exchangeCliToken}).
 *   Full and step-up-able.
 * - `device` — `run402 login --device`: RFC 8628 device authorization
 *   ({@link Session.deviceStart} + {@link Session.devicePoll}). Read-only: the
 *   gateway refuses every mutation with `403 SESSION_READ_ONLY`.
 *
 * Reached as `r.session.*`. Isomorphic — no Node APIs; the loopback server and
 * PKCE generation live in the Node CLI. The public *mint* methods send no auth
 * (the body, the magic-link token, or the code + verifier is the credential);
 * the *session-bound* methods take `opts.token` to send the bearer explicitly,
 * and fall back to the credential provider's default auth (e.g.
 * {@link controlPlaneSessionCredentials} or a SIWX wallet) when omitted.
 *
 * WebAuthn option/assertion payloads are opaque passthroughs (`unknown`) — the
 * browser runs the actual ceremony; a headless client cannot.
 *
 * High-stakes writes (invite, membership, transfer, delete) require a **fresh
 * passkey** — a magic-link/OAuth session does NOT satisfy step-up, so the
 * gateway returns {@link StepUpRequiredError}; `stepUpOptions`/`stepUpVerify`
 * are how a long-lived session re-establishes that freshness. A write approval
 * ({@link WriteApproval}) never satisfies step-up.
 */

import { gateSecret } from "../secret-gate.js";
import type { Client } from "../kernel.js";
import { ApiError, NetworkError } from "../errors.js";
import type { SessionGrade, WhoAmIResult } from "./org.types.js";

/**
 * A minted sign-in session (`POST /agent/v1/control-plane/cli/token`,
 * `…/cli/device/token`, and the browser mint routes). Forward-compatible.
 */
export interface ControlPlaneSession {
  control_plane_session_token: string;
  token_type?: string;
  /** Relative lifetime in seconds. */
  expires_in?: number;
  /** How it was minted: `browser`, `loopback`, or `device` (read-only). */
  grade?: SessionGrade | (string & {});
  /** The principal id. */
  principal_id?: string;
  /** Auth methods satisfied (e.g. `["passkey"]`). */
  amr?: string[];
  /** ISO-8601 absolute expiry, when the mint route reports one. */
  absolute_expires_at?: string;
  [key: string]: unknown;
}

/** RFC 8628 device-authorization start response (`POST …/cli/device`). */
export interface DeviceAuthStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** Pre-fills the user_code so the person can click straight through. */
  verification_uri_complete?: string;
  expires_in: number;
  /** Minimum seconds between `devicePoll` calls. */
  interval: number;
}

/**
 * Result of one {@link Session.devicePoll}. The non-approved states are the
 * RFC 8628 token error codes — expected polling states, NOT thrown errors, so
 * callers can run the poll loop without try/catch. An approved session carries
 * `grade: "device"`.
 */
export type DevicePollResult =
  | { kind: "approved"; session: ControlPlaneSession }
  | { kind: "authorization_pending" }
  | { kind: "slow_down" }
  | { kind: "access_denied" }
  | { kind: "expired_token" };

/** Parameters for {@link Session.buildCliAuthorizeUrl}. */
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

/** Parameters for {@link Session.exchangeCliToken}. */
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

/** OAuth identity providers bridged for sign-in. */
export type ControlPlaneOAuthProvider = "google" | "github";

/** Generic, non-enumerating response from {@link Session.email}. */
export interface MagicLinkSendResult {
  status: string;
  message: string;
  [key: string]: unknown;
}

/**
 * Result of {@link Session.consumeRecoveryCode} — a minted session that
 * cannot perform high-stakes ops until a passkey is enrolled
 * (`must_enroll_passkey: true`). Recovery `amr` never satisfies step-up.
 */
export interface RecoveryConsumeResult extends ControlPlaneSession {
  must_enroll_passkey?: boolean;
  note?: string;
}

/** Result of {@link Session.refresh} (`POST …/session/refresh`). */
export interface ControlPlaneRefreshResult {
  control_plane_session_token: string;
  token_type?: string;
  expires_in?: number;
  [key: string]: unknown;
}

/** WebAuthn options envelope (`{ options }`) — opaque; handed to the browser. */
export interface WebAuthnOptionsResult {
  options: unknown;
  [key: string]: unknown;
}

/** Result of {@link Session.enrollPasskeyVerify}. */
export interface EnrollPasskeyResult {
  status: string;
  credential_id: string;
  [key: string]: unknown;
}

/** Result of {@link Session.stepUpVerify}. */
export interface StepUpVerifyResult {
  status: string;
  stepped_up: boolean;
  [key: string]: unknown;
}

/** Result of {@link Session.issueRecoveryCodes} — shown ONCE. */
export interface RecoveryCodesResult {
  status: string;
  recovery_codes: string[];
  note?: string;
  [key: string]: unknown;
}

/** One active authenticator (no secret material). Forward-compatible. */
export interface Authenticator {
  id: string;
  kind: string;
  /** Provider-side subject hint (e.g. masked email / credential label); absent when unset. */
  subject_hint?: string;
  /** ISO-8601 enrollment time. */
  added_at?: string;
  /** ISO-8601 last-use time; absent when never used. */
  last_used_at?: string;
  [key: string]: unknown;
}

/** Result of {@link Session.revokeAuthenticator}. */
export interface AuthenticatorRevokeResult {
  status: string;
  kind: string;
  [key: string]: unknown;
}

/** Options bag carrying the optional `control_plane_session` bearer. */
export interface SessionTokenOpts {
  /**
   * The `control_plane_session` bearer. When omitted, the request falls back to
   * the credential provider's default auth (e.g. {@link controlPlaneSessionCredentials}).
   */
  token?: string;
}

export class Session {
  constructor(private readonly client: Client) {}

  // ── command-line login (public — no auth) ──

  /**
   * Build the loopback-PKCE authorize URL `run402 login` opens in the browser
   * (`GET /agent/v1/control-plane/cli/authorize`). Pure — no network. The
   * caller generates `codeChallenge`/`state`/`nonce` and runs the redirect
   * server on `127.0.0.1`.
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
   * `loopback`-grade sign-in session (`POST …/cli/token`). Unauthenticated —
   * the code + verifier are the credential.
   */
  async exchangeCliToken(params: CliTokenExchange): Promise<ControlPlaneSession> {
    gateSecret(this.client, "session.exchangeCliToken", params);
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

  /**
   * Begin RFC 8628 device authorization (`POST …/cli/device`) for
   * `run402 login --device`. Unauthenticated. Returns the codes the CLI prints
   * (`user_code` + `verification_uri`) plus the poll `interval` and
   * `expires_in`. The person approves in the console, which needs a recent
   * sign-in (`403 RECENT_SIGN_IN_REQUIRED` otherwise).
   */
  async deviceStart(): Promise<DeviceAuthStart> {
    return this.client.request<DeviceAuthStart>("/agent/v1/control-plane/cli/device", {
      method: "POST",
      body: {},
      withAuth: false,
      context: "starting device authorization",
    });
  }

  /**
   * Poll once for approval (`POST …/cli/device/token`). Bypasses the kernel's
   * error mapping on purpose: the RFC 8628 error codes (`authorization_pending`,
   * `slow_down`, ...) are normal polling states returned as data, not
   * exceptions. Only an unexpected response shape throws. The approved session
   * is `device` grade (read-only).
   */
  async devicePoll(deviceCode: string): Promise<DevicePollResult> {
    gateSecret(this.client, "session.devicePoll", deviceCode);
    const url = `${this.client.apiBase}/agent/v1/control-plane/cli/device/token`;
    let res: Response;
    try {
      res = await this.client.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: deviceCode }),
      });
    } catch (err) {
      throw new NetworkError(
        `Network error while polling device token: ${(err as Error).message}`,
        err,
        "polling device token",
      );
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && body && typeof body.control_plane_session_token === "string") {
      return { kind: "approved", session: body as unknown as ControlPlaneSession };
    }
    const error = body && typeof body.error === "string" ? body.error : null;
    if (error && POLL_ERROR_CODES.has(error)) {
      return { kind: error as Exclude<DevicePollResult["kind"], "approved"> };
    }
    throw new ApiError(
      `Unexpected device-token response (HTTP ${res.status})`,
      res.status,
      body,
      "polling device token",
    );
  }

  // ── login / mint (public — no auth; the body or link token is the credential) ──

  /**
   * Send a control-plane sign-in magic link to `email`
   * (`POST /agent/v1/control-plane/session/email`). Non-enumerating: an
   * identical response whether or not the email can sign in. Rate-limited.
   */
  async email(input: { email: string }): Promise<MagicLinkSendResult> {
    return this.client.request<MagicLinkSendResult>("/agent/v1/control-plane/session/email", {
      method: "POST",
      body: { email: input.email },
      withAuth: false,
      context: "sending control-plane magic link",
    });
  }

  /**
   * Exchange a magic-link token for a sign-in session
   * (`POST …/session/email/verify`). Verifies the email, resolves/creates the
   * principal, **auto-claims any pending invites**, and mints the session
   * (`amr: ["email"]`).
   */
  async verifyEmail(input: { token: string }): Promise<ControlPlaneSession> {
    gateSecret(this.client, "session.verifyEmail", input);
    return this.client.request<ControlPlaneSession>("/agent/v1/control-plane/session/email/verify", {
      method: "POST",
      body: { token: input.token },
      withAuth: false,
      context: "verifying control-plane magic link",
    });
  }

  /**
   * Get WebAuthn login options for an email's passkeys
   * (`POST …/session/passkey/options`). Opaque — pass `options` to the browser's
   * `navigator.credentials.get`.
   */
  async passkeyOptions(input: { email: string }): Promise<WebAuthnOptionsResult> {
    return this.client.request<WebAuthnOptionsResult>("/agent/v1/control-plane/session/passkey/options", {
      method: "POST",
      body: { email: input.email },
      withAuth: false,
      context: "requesting control-plane passkey login options",
    });
  }

  /**
   * Verify a WebAuthn assertion and mint a session (`amr: ["passkey"]`)
   * (`POST …/session/passkey/verify`). `response` is the opaque assertion from
   * the browser.
   */
  async passkeyVerify(input: { email: string; response: unknown }): Promise<ControlPlaneSession> {
    gateSecret(this.client, "session.passkeyVerify", input);
    return this.client.request<ControlPlaneSession>("/agent/v1/control-plane/session/passkey/verify", {
      method: "POST",
      body: { email: input.email, response: input.response },
      withAuth: false,
      context: "verifying control-plane passkey login",
    });
  }

  /**
   * Build the browser OAuth start URL for `provider`
   * (`GET …/oauth/:provider/start`). Pure — no network. Open it in a browser;
   * the gateway 302s to the provider, then the callback lands on the console
   * with the session token in the URL fragment.
   *
   * Note: the live bridge can return `503` until the gateway provisions the
   * provider's `CONTROL_PLANE_{GOOGLE,GITHUB}_*` client credentials.
   */
  oauthUrl(provider: ControlPlaneOAuthProvider): string {
    return `${this.client.apiBase}/agent/v1/control-plane/oauth/${encodeURIComponent(provider)}/start`;
  }

  /**
   * Run the recovery-code ceremony (`POST …/recovery/consume`). Mints a session
   * with `amr: ["recovery_code"]` which **cannot** do high-stakes ops
   * (`must_enroll_passkey: true`) — enrol a passkey to restore full access.
   */
  async consumeRecoveryCode(input: { code: string }): Promise<RecoveryConsumeResult> {
    gateSecret(this.client, "session.consumeRecoveryCode", input);
    return this.client.request<RecoveryConsumeResult>("/agent/v1/control-plane/recovery/consume", {
      method: "POST",
      body: { code: input.code },
      withAuth: false,
      context: "consuming control-plane recovery code",
    });
  }

  // ── session lifecycle (bearer; falls back to credential provider) ──

  /**
   * Resolve the session's principal, memberships, and `session` —
   * `{ grade, amr, amr_times }` (`GET /agent/v1/whoami`). The `memberships`
   * reflect any invites auto-claimed at sign-in. With no `token` the request
   * uses the credential provider, and `session` is `null` for a wallet caller.
   */
  async whoami(opts: SessionTokenOpts = {}): Promise<WhoAmIResult> {
    gateSecret(this.client, "session.whoami", opts);
    return this.client.request<WhoAmIResult>("/agent/v1/whoami", {
      ...authFor(opts),
      context: "resolving sign-in session",
    });
  }

  /** Rotate the access token (`POST …/session/refresh`). */
  async refresh(opts: SessionTokenOpts = {}): Promise<ControlPlaneRefreshResult> {
    gateSecret(this.client, "session.refresh", opts);
    return this.client.request<ControlPlaneRefreshResult>("/agent/v1/control-plane/session/refresh", {
      method: "POST",
      ...authFor(opts),
      context: "refreshing sign-in session",
    });
  }

  /** Sign out — revoke the session server-side (`POST …/session/revoke`). Idempotent. */
  async revoke(opts: SessionTokenOpts = {}): Promise<{ status: string; [key: string]: unknown }> {
    gateSecret(this.client, "session.revoke", opts);
    return this.client.request<{ status: string }>("/agent/v1/control-plane/session/revoke", {
      method: "POST",
      ...authFor(opts),
      context: "revoking sign-in session",
    });
  }

  // ── passkey enrollment (bearer + step-up, enforced by the gateway) ──

  /** WebAuthn registration options for a new passkey (`POST …/passkey/enroll/options`). */
  async enrollPasskeyOptions(opts: SessionTokenOpts = {}): Promise<WebAuthnOptionsResult> {
    gateSecret(this.client, "session.enrollPasskeyOptions", opts);
    return this.client.request<WebAuthnOptionsResult>("/agent/v1/control-plane/passkey/enroll/options", {
      method: "POST",
      ...authFor(opts),
      context: "requesting control-plane passkey enrollment options",
    });
  }

  /** Verify a passkey registration (`POST …/passkey/enroll/verify`). `label` names the authenticator. */
  async enrollPasskeyVerify(
    input: { response: unknown; label?: string | null } & SessionTokenOpts,
  ): Promise<EnrollPasskeyResult> {
    gateSecret(this.client, "session.enrollPasskeyVerify", input);
    const { token, response, label } = input;
    return this.client.request<EnrollPasskeyResult>("/agent/v1/control-plane/passkey/enroll/verify", {
      method: "POST",
      body: { response, ...(label !== undefined ? { label } : {}) },
      ...authFor({ token }),
      context: "verifying control-plane passkey enrollment",
    });
  }

  // ── step-up ceremony (bearer) ──

  /**
   * WebAuthn step-up options for a high-stakes op (`POST …/step-up/options`).
   * `opClass` binds the elevation, e.g. `"org.invite"` / `"org.membership"` /
   * `"project.transfer"` (see {@link StepUpRequiredError.requiredAmr}).
   */
  async stepUpOptions(input: { opClass?: string } & SessionTokenOpts = {}): Promise<WebAuthnOptionsResult> {
    gateSecret(this.client, "session.stepUpOptions", input);
    const { token, opClass } = input;
    return this.client.request<WebAuthnOptionsResult>("/agent/v1/control-plane/step-up/options", {
      method: "POST",
      body: opClass ? { op_class: opClass } : {},
      ...authFor({ token }),
      context: "requesting control-plane step-up options",
    });
  }

  /**
   * Verify a step-up assertion (`POST …/step-up/verify`) → refreshes session
   * passkey-freshness and records an action-bound elevation when `opClass` (and
   * optionally `objectKind`/`objectId`) are given. Retry the gated write after.
   */
  async stepUpVerify(
    input: {
      response: unknown;
      opClass?: string;
      objectKind?: string | null;
      objectId?: string | null;
    } & SessionTokenOpts,
  ): Promise<StepUpVerifyResult> {
    gateSecret(this.client, "session.stepUpVerify", input);
    const { token, response, opClass, objectKind, objectId } = input;
    return this.client.request<StepUpVerifyResult>("/agent/v1/control-plane/step-up/verify", {
      method: "POST",
      body: {
        response,
        ...(opClass !== undefined ? { op_class: opClass } : {}),
        ...(objectKind !== undefined ? { object_kind: objectKind } : {}),
        ...(objectId !== undefined ? { object_id: objectId } : {}),
      },
      ...authFor({ token }),
      context: "verifying control-plane step-up",
    });
  }

  // ── recovery codes (bearer + step-up) ──

  /** (Re)issue recovery codes — shown ONCE (`POST …/recovery/issue`). */
  async issueRecoveryCodes(opts: SessionTokenOpts = {}): Promise<RecoveryCodesResult> {
    gateSecret(this.client, "session.issueRecoveryCodes", opts);
    return this.client.request<RecoveryCodesResult>("/agent/v1/control-plane/recovery/issue", {
      method: "POST",
      ...authFor(opts),
      context: "issuing control-plane recovery codes",
    });
  }

  // ── authenticator management (bearer) ──

  /** List my active authenticators — no secret material (`GET …/authenticators`). */
  async listAuthenticators(opts: SessionTokenOpts = {}): Promise<Authenticator[]> {
    gateSecret(this.client, "session.listAuthenticators", opts);
    const res = await this.client.request<{ authenticators: Authenticator[] }>(
      "/agent/v1/control-plane/authenticators",
      { ...authFor(opts), context: "listing control-plane authenticators" },
    );
    return res.authenticators ?? [];
  }

  /**
   * Revoke an authenticator (`DELETE …/authenticators/:id`). Step-up enforced;
   * the gateway refuses to remove the last passkey of a sole org owner
   * (`OWNER_NEEDS_PASSKEY`).
   */
  async revokeAuthenticator(input: { id: string } & SessionTokenOpts): Promise<AuthenticatorRevokeResult> {
    gateSecret(this.client, "session.revokeAuthenticator", input);
    const { token, id } = input;
    return this.client.request<AuthenticatorRevokeResult>(
      `/agent/v1/control-plane/authenticators/${encodeURIComponent(id)}`,
      { method: "DELETE", ...authFor({ token }), context: "revoking control-plane authenticator" },
    );
  }

  // ── source-access custody (vault-recovery-custody; bearer) ──

  /**
   * My own source-access key + wrapper set, ciphertext included
   * (`GET /agent/v1/source-access/wrappers`) — the states/scheme read behind
   * `run402 repos access`. Principal-scoped structurally: only the
   * caller's own wrappers ever come back. Enrollment/activation/revocation
   * are console ceremonies (WebAuthn); this SDK surface is read-only.
   */
  async sourceAccessWrappers(opts: SessionTokenOpts = {}): Promise<SourceAccessWrappersResult> {
    gateSecret(this.client, "session.sourceAccessWrappers", opts);
    return this.client.request<SourceAccessWrappersResult>("/agent/v1/source-access/wrappers", {
      ...authFor(opts),
      context: "reading source-access wrappers",
    });
  }

  /**
   * Export my versioned member recovery bundle
   * (`GET /agent/v1/source-access/recovery-bundle`, format
   * `r402s-member-recovery-bundle/v1`) — key identity + every ACTIVE wrapper
   * ciphertext. A server-side wrapper row alone is NOT offline backup; this
   * bundle kept in the member's own storage (separately from the source
   * recovery code) is what `r402s-recover` opens with no run402 server. The
   * gateway stamps the export as recovery-posture evidence.
   */
  async sourceAccessRecoveryBundle(opts: SessionTokenOpts = {}): Promise<SourceAccessRecoveryBundleResult> {
    gateSecret(this.client, "session.sourceAccessRecoveryBundle", opts);
    return this.client.request<SourceAccessRecoveryBundleResult>("/agent/v1/source-access/recovery-bundle", {
      ...authFor(opts),
      context: "exporting source-access recovery bundle",
    });
  }
}

/** One wrapper row as `GET /agent/v1/source-access/wrappers` returns it. */
export interface SourceAccessWrapper {
  wrapper_id: string;
  encryption_key_id: string;
  kind: "webauthn_prf" | "recovery_code";
  state: "pending" | "active" | "revoked";
  format_version: string;
  credential_subject: string | null;
  wrapper_ciphertext: string;
  blob_sha256: string;
  created_at: string;
  activated_at: string | null;
}

export interface SourceAccessWrappersResult {
  principal_id: string;
  /** Null when the principal has never enrolled a source-access key. */
  encryption_key: {
    encryption_key_id: string;
    ek_fingerprint: string;
    public_key: string;
    suite: string;
    custody_scheme: string;
    state: string;
    created_at: string;
  } | null;
  wrappers: SourceAccessWrapper[];
}

/** `r402s-member-recovery-bundle/v1` exactly as the gateway returns it (see the node-side `VaultMemberRecoveryBundle` for the recover-input twin). */
export interface SourceAccessRecoveryBundleResult {
  format: "r402s-member-recovery-bundle/v1";
  exported_at: string;
  principal_id: string;
  encryption_key_id: string;
  ek_fingerprint: string;
  public_key: string;
  suite: string;
  custody_scheme: string;
  wrappers: Array<Omit<SourceAccessWrapper, "encryption_key_id" | "state" | "activated_at">>;
  note: string;
}

/**
 * Build the auth half of a request: explicit `Authorization: Bearer <token>`
 * (and `withAuth: false`) when a token is passed, else fall through to the
 * credential provider (`withAuth` defaults true).
 */
function authFor(opts: SessionTokenOpts): { headers?: Record<string, string>; withAuth?: boolean } {
  return opts.token
    ? { headers: { Authorization: `Bearer ${opts.token}` }, withAuth: false }
    : {};
}
