/**
 * `writeApproval` — the passkey-signed, target-scoped credential a person
 * signed in on the command line needs to provision, deploy, or write secrets
 * without a wallet. Reached as `r.writeApproval.*`.
 *
 * The ceremony: {@link WriteApproval.requestChallenge} opens a passkey approval
 * scoped to one `(action, target)` and returns a same-origin `confirm_url`; the
 * person approves with their passkey in the browser; the confirm page redirects
 * to the CLI's `127.0.0.1` loopback with a one-time `code`;
 * {@link WriteApproval.exchangeClaimCode} (PKCE) mints the token. The token is
 * sent as `X-Run402-Write-Approval: Bearer <write_approval_token>` beside the
 * sign-in session bearer, and dies with that session. A write approval never
 * satisfies step-up.
 *
 * Isomorphic seams — the loopback server and PKCE generation live in the Node
 * CLI (`run402 approve`).
 */

import type { Client } from "../kernel.js";
import type { WriteApprovalCapability } from "../credentials.js";

/** Input to {@link WriteApproval.requestChallenge}. */
export interface WriteApprovalChallengeInput {
  /** The capability to approve. Determines whether `orgId` or `projectId` is required. */
  action: WriteApprovalCapability;
  /** Required for `org.project.create`. */
  orgId?: string;
  /** Required for the project-scoped capabilities (`project.deploy`, `project.secret.write`, …). */
  projectId?: string;
  /** The CLI's loopback redirect, e.g. `http://127.0.0.1:54321/callback`. */
  cliRedirectUri: string;
  /** PKCE S256 challenge = base64url(sha256(verifier)). */
  codeChallenge: string;
  /** Opaque CSRF state echoed back on the loopback redirect. */
  state: string;
  /**
   * The sign-in session bearer. Falls back to the client's default auth when
   * omitted — pass it explicitly unless the client was constructed with
   * sign-in session credentials.
   */
  token?: string;
}

/** Result of {@link WriteApproval.requestChallenge}. Forward-compatible. */
export interface WriteApprovalChallengeResult {
  challenge_id: string;
  confirm_url: string;
  expires_at?: string;
  action?: string;
  org_id?: string | null;
  project_id?: string | null;
  delivery?: "cli_loopback" | "postmessage" | (string & {});
  [key: string]: unknown;
}

/** Input to {@link WriteApproval.exchangeClaimCode}. */
export interface WriteApprovalClaimInput {
  /** Authorization code received on the loopback redirect. */
  code: string;
  /** The PKCE verifier whose hash was sent as `codeChallenge`. */
  codeVerifier: string;
  /** Must match the `state` used at challenge time. */
  state: string;
}

/** One write approval's metadata as the gateway reports it (never the token). */
export interface WriteApprovalSessionInfo {
  write_approval_session_id: string;
  authenticator_class?: string;
  org_id?: string | null;
  project_id?: string | null;
  capabilities?: string[];
  risk_ceiling?: string;
  /** ISO-8601 idle expiry — the token's usable life. */
  idle_expires_at?: string;
  /** ISO-8601 absolute expiry. */
  absolute_expires_at?: string;
  [key: string]: unknown;
}

/** Minted write-approval token payload, returned ONCE. Forward-compatible. */
export interface WriteApprovalTokenResult {
  write_approval_token: string;
  /** Always `"write_approval"`. */
  token_type?: string;
  /** Always `"X-Run402-Write-Approval"`. */
  header?: string;
  session?: WriteApprovalSessionInfo | null;
  [key: string]: unknown;
}

export class WriteApproval {
  constructor(private readonly client: Client) {}

  /**
   * Open a scoped approval (`POST /agent/v1/control-plane/write-approval/challenges`).
   * Carries the sign-in session bearer; a `device`-grade session is refused.
   */
  async requestChallenge(input: WriteApprovalChallengeInput): Promise<WriteApprovalChallengeResult> {
    const body: Record<string, unknown> = {
      action: input.action,
      cli_redirect_uri: input.cliRedirectUri,
      code_challenge: input.codeChallenge,
      state: input.state,
    };
    if (input.orgId !== undefined) body.org_id = input.orgId;
    if (input.projectId !== undefined) body.project_id = input.projectId;
    return this.client.request<WriteApprovalChallengeResult>(
      "/agent/v1/control-plane/write-approval/challenges",
      {
        method: "POST",
        body,
        ...(input.token
          ? { headers: { Authorization: `Bearer ${input.token}` }, withAuth: false }
          : {}),
        context: "requesting a write approval challenge",
      },
    );
  }

  /**
   * Exchange the loopback claim `code` (+ PKCE verifier + `state`) for the
   * write-approval token (`POST …/write-approval/cli/token`). No `redirect_uri`
   * — it is bound at challenge time. Unauthenticated (code + verifier are the
   * credential); the minted token is still bound to the issuing sign-in session.
   */
  async exchangeClaimCode(input: WriteApprovalClaimInput): Promise<WriteApprovalTokenResult> {
    return this.client.request<WriteApprovalTokenResult>(
      "/agent/v1/control-plane/write-approval/cli/token",
      {
        method: "POST",
        body: { code: input.code, code_verifier: input.codeVerifier, state: input.state },
        withAuth: false,
        context: "exchanging a write approval claim code",
      },
    );
  }
}
