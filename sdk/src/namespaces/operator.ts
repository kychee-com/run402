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
import { ApiError, NetworkError } from "../errors.js";

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

const POLL_ERROR_CODES = new Set([
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
]);

export class Operator {
  constructor(private readonly client: Client) {}

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
}
