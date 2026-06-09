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
 * Gateway contract: kychee-com/run402-private#443 (RFC 8628 device-auth bridge).
 */

import type { Client } from "../kernel.js";
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
 * Account overview. Forward-compatible: the gateway owns the exact shape and
 * may add fields, so unknown keys are preserved via the index signature.
 * `scope.kind` is `"email"` for the operator-session (email-union) and
 * `"wallet"` for a SIWX slice.
 */
export interface OperatorOverview {
  scope?: { kind?: "email" | "wallet" | string; principal?: string };
  rollup?: Record<string, unknown>;
  billing_accounts?: unknown[];
  wallets?: unknown[];
  advisories?: unknown[];
  [key: string]: unknown;
}

/**
 * A write-capable control-plane session minted by the loopback-PKCE flow
 * (`POST /agent/v1/control-plane/cli/token`). Distinct from the device-flow
 * {@link OperatorSessionToken} (read-only): this carries `provenance` and
 * `amr`, and is accepted everywhere a SIWX wallet is. Forward-compatible.
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

// ── Wallet-owned org claim (v1.82, first-class-orgs) ──────────────────────────

/**
 * A claim challenge (`POST …/claim-wallet-org/challenge`). The wallet must sign a
 * fresh SIWX message carrying {@link ClaimChallenge.nonce}; that signed message
 * becomes the `SIGN-IN-WITH-X` header on {@link ClaimWalletOrg.submit}. Reveals
 * nothing about the wallet's orgs — control is proven only at claim time.
 */
export interface ClaimChallenge {
  challenge_id: string;
  nonce: string;
  expires_at: string;
  sign_instructions?: { scheme?: string; nonce?: string; note?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Input to {@link ClaimWalletOrg.challenge}. */
export interface ClaimChallengeInput {
  /** The wallet (0x EVM address) whose agent-owned org is being claimed. */
  wallet: string;
  /**
   * The human's write-capable control-plane session bearer. Falls back to the
   * client's default auth when omitted — pass it explicitly unless the client was
   * constructed with control-plane-session credentials.
   */
  token?: string;
}

/** Input to {@link ClaimWalletOrg.submit}. */
export interface ClaimSubmitInput {
  /**
   * The fresh SIWX proof over the challenge nonce — the value of the
   * `SIGN-IN-WITH-X` header (the wallet proof). In Node, build it with
   * `signWalletOrgClaim` from `@run402/sdk/node`.
   */
  siwx: string;
  /** The human's control-plane session bearer (see {@link ClaimChallengeInput.token}). */
  token?: string;
  /**
   * Target org id. Omit on the first submit; supply it on the second round when
   * the first returned `select_org` (the wallet's agent owns more than one org).
   * The same `token` + `siwx` are reused — no re-challenge, no re-sign.
   */
  orgId?: string;
  /** Optional label to set on the claimed org at the same time. `null`/`""` clears. */
  displayName?: string | null;
}

/** One org offered for selection when a wallet's agent owns more than one (`select_org`). */
export interface SelectableOrg {
  org_id: string;
  display_name: string | null;
  tier: string;
  [key: string]: unknown;
}

/**
 * Result of {@link ClaimWalletOrg.submit}. A discriminated union: `"claimed"` on
 * success, or `"select_org"` when the wallet's agent owns more than one org and
 * the caller must re-submit with a chosen `orgId`. `select_org` is a normal
 * (non-error) result — it is returned, never thrown.
 */
export type ClaimResult =
  | {
      status: "claimed";
      org_id: string;
      display_name: string | null;
      role: string;
      /** True when the human already owned the org (idempotent re-claim). */
      already_owned?: boolean;
      [key: string]: unknown;
    }
  | {
      status: "select_org";
      selectable_orgs: SelectableOrg[];
      [key: string]: unknown;
    };

/**
 * Wallet-owned org claim — `r.operator.claimWalletOrg.*`. The isomorphic
 * (raw-proof) seam: `challenge` issues a nonce; `submit` posts the dual proof
 * (control-plane session bearer + a fresh `SIGN-IN-WITH-X` wallet signature). The
 * Node convenience `signWalletOrgClaim` / `claimWalletOrg` in `@run402/sdk/node`
 * runs the whole dance (read session → challenge → sign → submit).
 */
export class ClaimWalletOrg {
  constructor(private readonly client: Client) {}

  /** Request a single-use challenge nonce the wallet must sign (`POST …/claim-wallet-org/challenge`). */
  async challenge(input: ClaimChallengeInput): Promise<ClaimChallenge> {
    if (!input?.wallet) {
      throw new LocalError("claimWalletOrg.challenge requires { wallet }", "requesting wallet-org claim challenge");
    }
    return this.client.request<ClaimChallenge>("/agent/v1/operator/claim-wallet-org/challenge", {
      method: "POST",
      body: { wallet: input.wallet },
      ...(input.token ? { headers: { Authorization: `Bearer ${input.token}` }, withAuth: false } : {}),
      context: "requesting wallet-org claim challenge",
    });
  }

  /**
   * Execute the claim (`POST …/claim-wallet-org`) carrying both proofs: the
   * control-plane session bearer (the human) and the `SIGN-IN-WITH-X` wallet
   * signature. Returns a discriminated {@link ClaimResult}; a `select_org` result
   * is returned (not thrown). Throws {@link StepUpRequiredError} when the session
   * is not passkey-fresh, and `ApiError` (`WALLET_PROOF_INVALID`) on a bad proof.
   */
  async submit(input: ClaimSubmitInput): Promise<ClaimResult> {
    if (!input?.siwx) {
      throw new LocalError("claimWalletOrg.submit requires { siwx } (the SIGN-IN-WITH-X proof)", "claiming wallet org");
    }
    const headers: Record<string, string> = { "SIGN-IN-WITH-X": input.siwx };
    if (input.token) headers.Authorization = `Bearer ${input.token}`;
    const body: Record<string, unknown> = {};
    if (input.orgId !== undefined) body.org_id = input.orgId;
    if (input.displayName !== undefined) body.display_name = input.displayName;
    return this.client.request<ClaimResult>("/agent/v1/operator/claim-wallet-org", {
      method: "POST",
      body,
      headers,
      withAuth: !input.token,
      context: "claiming wallet org",
    });
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
   * Wallet-owned org claim (v1.82): `r.operator.claimWalletOrg.challenge()` +
   * `.submit()`. The raw dual-proof seam; the Node convenience `claimWalletOrg`
   * in `@run402/sdk/node` runs the full dance.
   */
  readonly claimWalletOrg: ClaimWalletOrg;

  constructor(private readonly client: Client) {
    this.session = new OperatorSession(client);
    this.claimWalletOrg = new ClaimWalletOrg(client);
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
   * Fetch the account overview. With `opts.token` the request carries the
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
