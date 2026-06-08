/**
 * `operator.session` — the hosted/browser control-plane **session** surface
 * (gateway v1.78 `passkey-principals-onboarding`). The write-capable human
 * principal: log in (email magic-link / passkey / Google / GitHub), manage the
 * session (whoami / refresh / revoke), enrol a passkey, run a step-up ceremony,
 * and manage authenticators + recovery codes.
 *
 * Reached as `r.operator.session.*`. Distinct from the read-only operator
 * overview session (`r.operator.deviceStart`/`overview`) and from the CLI
 * loopback-PKCE write-login (`r.operator.buildCliAuthorizeUrl`/`exchangeCliToken`,
 * which is the headless variant of this same browser ceremony). All three are
 * the one human principal; this group is the browser/console front door that the
 * hosted login pages and `@run402/sdk` consumers call.
 *
 * Isomorphic — no Node APIs. The token model mirrors {@link Operator.overview}:
 * the public *mint* methods (`email`/`verifyEmail`/`passkey*`/`consumeRecoveryCode`)
 * send no auth (the body or the magic-link token IS the credential); the
 * *session-bound* methods take `opts.token` to send the `control_plane_session`
 * bearer explicitly, and fall back to the credential provider's default auth
 * (e.g. {@link controlPlaneSessionCredentials} or a SIWX wallet) when omitted.
 *
 * WebAuthn option/assertion payloads are opaque passthroughs (`unknown`) — the
 * browser runs the actual ceremony; a headless client cannot.
 *
 * High-stakes writes (invite, membership, handoff, delete) require a **fresh
 * passkey** — a magic-link/OAuth session does NOT satisfy step-up, so the
 * gateway returns {@link StepUpRequiredError}; `stepUpOptions`/`stepUpVerify`
 * are how a long-lived session re-establishes that freshness.
 */

import type { Client } from "../kernel.js";
import type { ControlPlaneSession } from "./operator.js";
import type { Principal, OrgMembership } from "./org.types.js";

/** OAuth identity providers bridged for control-plane login. */
export type ControlPlaneOAuthProvider = "google" | "github";

/** Generic, non-enumerating response from {@link OperatorSession.email}. */
export interface MagicLinkSendResult {
  status: string;
  message: string;
  [key: string]: unknown;
}

/**
 * Result of {@link OperatorSession.consumeRecoveryCode} — a minted session that
 * cannot perform high-stakes ops until a passkey is enrolled
 * (`must_enroll_passkey: true`). Recovery `amr` never satisfies step-up.
 */
export interface RecoveryConsumeResult extends ControlPlaneSession {
  must_enroll_passkey?: boolean;
  note?: string;
}

/**
 * Result of {@link OperatorSession.whoami} (`GET /agent/v1/control-plane/session`)
 * — the live session's principal, every org membership (newly-active rows here
 * are the auto-claimed invites), and the freshness substrate (`amr` + per-AMR
 * `amr_times`) the step-up gate reads. Forward-compatible.
 */
export interface ControlPlaneWhoAmI {
  principal: Principal;
  memberships: OrgMembership[];
  /** Auth methods satisfied on this session, e.g. `["passkey"]`. */
  amr: string[];
  /** Per-AMR last-proven time (epoch ms or ISO), the step-up freshness source. */
  amr_times?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Result of {@link OperatorSession.refresh} (`POST …/session/refresh`). */
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

/** Result of {@link OperatorSession.enrollPasskeyVerify}. */
export interface EnrollPasskeyResult {
  status: string;
  credential_id: string;
  [key: string]: unknown;
}

/** Result of {@link OperatorSession.stepUpVerify}. */
export interface StepUpVerifyResult {
  status: string;
  stepped_up: boolean;
  [key: string]: unknown;
}

/** Result of {@link OperatorSession.issueRecoveryCodes} — shown ONCE. */
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
  [key: string]: unknown;
}

/** Result of {@link OperatorSession.revokeAuthenticator}. */
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

export class OperatorSession {
  constructor(private readonly client: Client) {}

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
   * Exchange a magic-link token for a control-plane session
   * (`POST …/session/email/verify`). Verifies the email, resolves/creates the
   * principal, **auto-claims any pending invites**, and mints the session
   * (`amr: ["email"]`).
   */
  async verifyEmail(input: { token: string }): Promise<ControlPlaneSession> {
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
    return this.client.request<RecoveryConsumeResult>("/agent/v1/control-plane/recovery/consume", {
      method: "POST",
      body: { code: input.code },
      withAuth: false,
      context: "consuming control-plane recovery code",
    });
  }

  // ── session lifecycle (bearer; falls back to credential provider) ──

  /**
   * Resolve the current session's principal + memberships + freshness
   * (`GET /agent/v1/control-plane/session`). The `memberships` reflect any
   * invites auto-claimed at login.
   */
  async whoami(opts: SessionTokenOpts = {}): Promise<ControlPlaneWhoAmI> {
    return this.client.request<ControlPlaneWhoAmI>("/agent/v1/control-plane/session", {
      ...authFor(opts),
      context: "resolving control-plane session",
    });
  }

  /** Rotate the access token (`POST …/session/refresh`). */
  async refresh(opts: SessionTokenOpts = {}): Promise<ControlPlaneRefreshResult> {
    return this.client.request<ControlPlaneRefreshResult>("/agent/v1/control-plane/session/refresh", {
      method: "POST",
      ...authFor(opts),
      context: "refreshing control-plane session",
    });
  }

  /** Sign out — revoke the session server-side (`POST …/session/revoke`). Idempotent. */
  async revoke(opts: SessionTokenOpts = {}): Promise<{ status: string; [key: string]: unknown }> {
    return this.client.request<{ status: string }>("/agent/v1/control-plane/session/revoke", {
      method: "POST",
      ...authFor(opts),
      context: "revoking control-plane session",
    });
  }

  // ── passkey enrollment (bearer + step-up, enforced by the gateway) ──

  /** WebAuthn registration options for a new passkey (`POST …/passkey/enroll/options`). */
  async enrollPasskeyOptions(opts: SessionTokenOpts = {}): Promise<WebAuthnOptionsResult> {
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
    return this.client.request<RecoveryCodesResult>("/agent/v1/control-plane/recovery/issue", {
      method: "POST",
      ...authFor(opts),
      context: "issuing control-plane recovery codes",
    });
  }

  // ── authenticator management (bearer) ──

  /** List my active authenticators — no secret material (`GET …/authenticators`). */
  async listAuthenticators(opts: SessionTokenOpts = {}): Promise<Authenticator[]> {
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
    const { token, id } = input;
    return this.client.request<AuthenticatorRevokeResult>(
      `/agent/v1/control-plane/authenticators/${encodeURIComponent(id)}`,
      { method: "DELETE", ...authFor({ token }), context: "revoking control-plane authenticator" },
    );
  }
}

/**
 * Build the auth half of a request: explicit `Authorization: Bearer <token>`
 * (and `withAuth: false`) when a token is passed, else fall through to the
 * credential provider (`withAuth` defaults true). Mirrors {@link Operator.overview}.
 */
function authFor(opts: SessionTokenOpts): { headers?: Record<string, string>; withAuth?: boolean } {
  return opts.token
    ? { headers: { Authorization: `Bearer ${opts.token}` }, withAuth: false }
    : {};
}
