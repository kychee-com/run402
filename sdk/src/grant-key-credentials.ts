/**
 * Grant-key credential helpers.
 *
 * A grant key is a credential an OWNER mints against exactly one project grant
 * for an agent: narrower than the grant, spend-capped, expiring, revocable on
 * its own, and never an owner. It authenticates the same routes a CI session
 * does — including the apikey-gated `/content/v1/*` CAS routes — so from the
 * client's perspective it behaves exactly like the CI session path: the bearer
 * rides `Authorization`, and helpers that would otherwise attach a project
 * `apikey` must stand down so the two credential families never mix on one
 * request.
 *
 * Why this exists at all: project API keys are stateless JWTs issued once at
 * project-create and never re-issued. An agent that loses local state (fresh
 * container, new sandbox) therefore has no cached apikey and no way to deploy
 * to a project it owns. The owner still holds the wallet, so they can mint a
 * grant key with SIWX and hand it to the agent.
 */

import type { CredentialsProvider } from "./credentials.js";

export const GRANT_KEY_CREDENTIALS = Symbol.for("@run402/sdk/grant-key-credentials");

export interface GrantKeyMarkedCredentialsProvider extends CredentialsProvider {
  readonly [GRANT_KEY_CREDENTIALS]: true;
}

/**
 * True when this provider is presenting a grant-key bearer for the current
 * request family. Consumers use it the same way they use
 * `isCiSessionCredentials` — to suppress apikey attachment.
 */
export function isGrantKeyCredentials(credentials: CredentialsProvider): boolean {
  return Boolean((credentials as Partial<GrantKeyMarkedCredentialsProvider>)[GRANT_KEY_CREDENTIALS]);
}

/** Environment variable carrying a grant-key bearer for non-interactive runs. */
export const GRANT_KEY_ENV = "RUN402_GRANT_KEY";

/**
 * Read a grant-key bearer from the environment. Whitespace-trimmed; an empty or
 * whitespace-only value is treated as absent so `RUN402_GRANT_KEY=` in a shell
 * profile does not silently disable every other credential class.
 */
export function grantKeyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[GRANT_KEY_ENV];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
