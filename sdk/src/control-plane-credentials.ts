/**
 * Control-plane **session** credential provider (gateway v1.78). Carries a
 * write-capable `control_plane_session` bearer so the whole SDK authenticates as
 * the human principal — the token is "accepted everywhere a SIWX wallet is", so
 * `r.org.*`, `r.admin.transfers.*`, and `r.operator.session.*` all act as that
 * principal.
 *
 * Isomorphic — no Node APIs. Mint a session with `r.operator.session.verifyEmail`
 * / `passkeyVerify` / the loopback-PKCE `exchangeCliToken`, then:
 *
 *   const r = run402({ credentials: controlPlaneSessionCredentials({ token }) });
 *   await r.org.whoami();            // resolves the principal + memberships
 *
 * High-stakes writes still require a fresh passkey — an `email`/`oauth` session
 * gets {@link StepUpRequiredError}; run the step-up ceremony
 * (`r.operator.session.stepUpOptions`/`stepUpVerify`) and retry.
 *
 * This credential authenticates control-plane operations only; it carries no
 * project anon/service keys, so {@link CredentialsProvider.getProject} returns
 * null (project-key operations need the keystore/wallet).
 */

import type { CredentialsProvider, ProjectKeys } from "./credentials.js";
import { LocalError } from "./errors.js";

/** Brand marking a provider as control-plane-session-backed. */
export const CONTROL_PLANE_SESSION_CREDENTIALS = Symbol.for(
  "@run402/sdk/control-plane-session-credentials",
);

export interface ControlPlaneSessionMarkedCredentialsProvider extends CredentialsProvider {
  readonly [CONTROL_PLANE_SESSION_CREDENTIALS]: true;
}

export interface ControlPlaneSessionCredentialsOptions {
  /** A `control_plane_session` bearer token. Provide this OR `getToken`. */
  token?: string;
  /**
   * Lazily resolve the current token (e.g. read a cache, or rotate via
   * `r.operator.session.refresh`). Called before every authenticated request.
   */
  getToken?: () => string | Promise<string>;
}

/** True if `credentials` was created by {@link controlPlaneSessionCredentials}. */
export function isControlPlaneSessionCredentials(
  credentials: CredentialsProvider,
): credentials is ControlPlaneSessionMarkedCredentialsProvider {
  return Boolean(
    (credentials as Partial<ControlPlaneSessionMarkedCredentialsProvider>)[
      CONTROL_PLANE_SESSION_CREDENTIALS
    ],
  );
}

/**
 * Build a {@link CredentialsProvider} that authenticates every request with a
 * `control_plane_session` bearer. Pass a static `token`, or a `getToken`
 * resolver for rotation.
 */
export function controlPlaneSessionCredentials(
  opts: ControlPlaneSessionCredentialsOptions,
): ControlPlaneSessionMarkedCredentialsProvider {
  if (!opts?.token && !opts?.getToken) {
    throw new LocalError(
      "controlPlaneSessionCredentials requires token or getToken",
      "creating control-plane session credentials",
    );
  }

  const provider: CredentialsProvider = {
    async getAuth() {
      const token = opts.getToken ? await opts.getToken() : opts.token;
      if (!token) {
        throw new LocalError(
          "control-plane session credentials did not return a token",
          "authenticating with control-plane session",
        );
      }
      return { Authorization: `Bearer ${token}` };
    },
    async getProject(): Promise<ProjectKeys | null> {
      // A control-plane session carries no project anon/service keys.
      return null;
    },
  };

  Object.defineProperty(provider, CONTROL_PLANE_SESSION_CREDENTIALS, {
    value: true,
    enumerable: false,
  });
  return provider as ControlPlaneSessionMarkedCredentialsProvider;
}
