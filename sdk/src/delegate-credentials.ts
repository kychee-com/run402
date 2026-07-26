/**
 * Delegate-credential helpers.
 *
 * A delegate is a scoped, revocable, expiring bearer an OWNER mints for an
 * agent (gateway `cryptographic-delegates`, v1.79). It authenticates the same
 * routes a CI session does — including the apikey-gated `/content/v1/*` CAS
 * routes — so from the client's perspective it behaves exactly like the CI
 * session path: the bearer rides `Authorization`, and helpers that would
 * otherwise attach a project `apikey` must stand down so the two credential
 * families never mix on one request.
 *
 * Why this exists at all: project API keys are stateless JWTs issued once at
 * project-create and never re-issued. An agent that loses local state (fresh
 * container, new sandbox) therefore has no cached apikey and no way to deploy
 * to a project it owns. The owner still holds the wallet, so they can mint a
 * delegate with SIWX and hand it to the agent. See kychee-com/run402-private#624.
 */

import type { CredentialsProvider } from "./credentials.js";

export const DELEGATE_CREDENTIALS = Symbol.for("@run402/sdk/delegate-credentials");

export interface DelegateMarkedCredentialsProvider extends CredentialsProvider {
  readonly [DELEGATE_CREDENTIALS]: true;
}

/**
 * True when this provider is presenting a delegate bearer for the current
 * request family. Consumers use it the same way they use
 * `isCiSessionCredentials` — to suppress apikey attachment.
 */
export function isDelegateCredentials(credentials: CredentialsProvider): boolean {
  return Boolean((credentials as Partial<DelegateMarkedCredentialsProvider>)[DELEGATE_CREDENTIALS]);
}

/** Environment variable carrying a delegate bearer for non-interactive runs. */
export const DELEGATE_TOKEN_ENV = "RUN402_DELEGATE_TOKEN";

/**
 * Read a delegate bearer from the environment. Whitespace-trimmed; an empty or
 * whitespace-only value is treated as absent so `RUN402_DELEGATE_TOKEN=` in a
 * shell profile does not silently disable every other credential class.
 */
export function delegateTokenFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[DELEGATE_TOKEN_ENV];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
