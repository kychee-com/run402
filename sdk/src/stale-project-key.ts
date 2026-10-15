import type { ProjectKeys } from "./credentials.js";
import type { Client } from "./kernel.js";
import { isRun402Error, Unauthorized, type NextAction, type Run402Error } from "./errors.js";

/**
 * A locally cached project key the gateway refused at authentication.
 *
 * The project database routes (SQL, schema, project REST) accept either a
 * service key or the caller's own principal, and the gateway picks the chain by
 * the credential's shape, so it cannot fall back on its own: a cached key that
 * expired or was revoked fails every call even when the caller's wallet or
 * sign-in session would be authorized. These helpers make that fallback on the
 * client.
 *
 * The codes below come only from the credential check that runs before any
 * route handler (revoked or expired, an unknown secret, an unverifiable legacy
 * key), so the refused request had no effect and repeating it as the
 * principal is safe for reads and writes alike.
 */
const STALE_PROJECT_KEY_CODES = new Set(["CREDENTIAL_REVOKED", "CREDENTIAL_MISSING", "INVALID_AUTH"]);

/**
 * Keys this credentials provider has seen refused, per project, so later calls
 * in the same process go straight to the principal. Keyed by the key value, so
 * re-importing a fresh key makes it usable again.
 */
const refusedKeys = new WeakMap<object, Map<string, string>>();

function refusedFor(client: Client): Map<string, string> {
  const owner = client.credentials as object;
  let map = refusedKeys.get(owner);
  if (!map) {
    map = new Map();
    refusedKeys.set(owner, map);
  }
  return map;
}

/** The cached keys for `projectId`, or null when none are cached or this process saw the service key refused. */
export async function usableProjectKeys(client: Client, projectId: string): Promise<ProjectKeys | null> {
  const keys = await client.getProjectCredentials(projectId);
  if (!keys) return null;
  return refusedFor(client).get(projectId) === keys.service_key ? null : keys;
}

function isStaleKeyRefusal(err: unknown): err is Run402Error {
  return isRun402Error(err) && err.status === 401 && STALE_PROJECT_KEY_CODES.has(err.code ?? "");
}

/** The command that drops a stale entry from this machine's project-key cache. */
export function deleteCachedProjectKeysCommand(projectId: string): string {
  return `run402 credentials project-keys delete --project ${projectId}`;
}

/** The gateway's refusal, with the stale local cache entry named as the first next action. */
function staleKeyError(err: Run402Error, projectId: string): Unauthorized {
  const body = err.body && typeof err.body === "object" && !Array.isArray(err.body)
    ? (err.body as Record<string, unknown>)
    : {};
  const remove: NextAction = {
    type: "run_cli_command",
    command: deleteCachedProjectKeysCommand(projectId),
    why: "This machine's cached project key was refused. Delete the stale cache entry so the call goes as your wallet or sign-in session, or re-key with `run402 credentials issue --kind service --name <name> --import`.",
  };
  const existing = Array.isArray(body.next_actions) ? (body.next_actions as NextAction[]) : [];
  return new Unauthorized(
    err.message,
    err.status,
    {
      ...body,
      hint: "The locally cached project key was refused (expired, revoked or unknown), and no wallet or sign-in session could make the call instead.",
      next_actions: [remove, ...existing],
    },
    err.context,
  );
}

/**
 * Run `call` with the cached keys; when the gateway refuses the cached key at
 * authentication, run it once more as the caller's principal (`call(null)`).
 * When the principal is refused too (no wallet or session), throw the
 * original refusal with the stale cache entry named.
 */
export async function withPrincipalFallback<T>(
  client: Client,
  projectId: string,
  keys: ProjectKeys | null,
  call: (keys: ProjectKeys | null) => Promise<T>,
): Promise<T> {
  try {
    return await call(keys);
  } catch (err) {
    if (!keys || !isStaleKeyRefusal(err)) throw err;
    refusedFor(client).set(projectId, keys.service_key);
    try {
      return await call(null);
    } catch (retryErr) {
      if (isRun402Error(retryErr) && retryErr.status === 401) throw staleKeyError(err, projectId);
      throw retryErr;
    }
  }
}
