/**
 * Signed-in preview under `astro dev`: `run402 dev --as <label>`.
 *
 * `run402 dev --as <label>` mints a platform test session (a watermarked
 * `<label>@<project_id>.test.invalid` user, never a real member) with the
 * project's service key and hands it to the `astro dev` child it spawns in
 * one environment variable. The adapter registers the dev-session middleware
 * only when Astro's command is `dev` and that variable is set, so no build
 * ever contains it; the middleware runs each request inside the same request
 * context the deployed SSR runtime builds from a verified gateway envelope:
 * an explicit actor plus the data-plane token `db()` forwards.
 *
 * Nothing here reaches the browser: the bearer lives in the dev server's
 * process environment and in the per-request context only.
 */

/** The environment variable `run402 dev --as` sets for the `astro dev` child. */
export const DEV_TEST_SESSION_ENV = "RUN402_DEV_TEST_SESSION";

/** The header the gateway uses to hand the runtime a visitor's data-plane token. */
const DATA_PLANE_ACTOR_TOKEN_HEADER = "x-run402-actor-token";

/** What `run402 dev --as` passes: the parts of the test-session bundle the dev server needs. */
export interface DevTestSession {
  project_id: string;
  user: { id: string; label: string; email: string; email_verified: boolean };
  session: { session_id: string; amr: string[]; auth_time: string };
  access_token: string;
  /** The earlier of the bearer's and the session's expiry, ISO-8601. */
  expires_at: string;
}

/** The context shape `runWithContext` from `@run402/functions` accepts. */
export interface DevRequestContext {
  requestId: string;
  projectId: string;
  releaseId: string;
  locale: null;
  defaultLocale: null;
  host: string;
  request: { method: string; url: string; headers: Record<string, string> };
  actor: {
    id: string;
    email: string;
    isTest: true;
    emailVerified: boolean;
    authTime: number;
    amr: string[];
    amrTimes: Record<string, number>;
    authzVersion: number;
    sessionId: string;
  };
  invocationKind: "routed_http";
}

export type RunWithContext = <T>(context: DevRequestContext, callback: () => Promise<T> | T) => Promise<T> | T;

/** True only for `astro dev` with a dev test session handed over. */
export function shouldInstallDevSession(command: string, env: NodeJS.ProcessEnv): boolean {
  return command === "dev" && typeof env[DEV_TEST_SESSION_ENV] === "string" && env[DEV_TEST_SESSION_ENV] !== "";
}

/** Parse the handed-over session; throws on a value `run402 dev` did not write. */
export function parseDevTestSession(raw: string): DevTestSession {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${DEV_TEST_SESSION_ENV} is not JSON; restart with \`run402 dev --as <label>\`.`);
  }
  const v = value as Partial<DevTestSession>;
  const ok =
    typeof v.project_id === "string" &&
    typeof v.user?.id === "string" &&
    typeof v.user.email === "string" &&
    typeof v.session?.session_id === "string" &&
    Array.isArray(v.session.amr) &&
    typeof v.session.auth_time === "string" &&
    typeof v.access_token === "string" &&
    typeof v.expires_at === "string";
  if (!ok) {
    throw new Error(`${DEV_TEST_SESSION_ENV} is missing fields; restart with \`run402 dev --as <label>\`.`);
  }
  return v as DevTestSession;
}

/** The token's `authz_version` claim (0 when absent). The gateway minted it; nothing here trusts it for access. */
function authzVersionOf(accessToken: string): number {
  const payload = accessToken.split(".")[1];
  if (!payload) return 0;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { authz_version?: unknown };
    return typeof claims.authz_version === "number" ? claims.authz_version : 0;
  } catch {
    return 0;
  }
}

/**
 * The request context for one dev request, or `null` once the session has
 * expired. Inbound `x-run402-*` headers are dropped: in the deployed runtime
 * only the gateway sets them.
 */
export function devRequestContext(
  session: DevTestSession,
  request: Request,
  now: number,
  requestId: string,
): DevRequestContext | null {
  if (now >= Date.parse(session.expires_at)) return null;
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (!name.toLowerCase().startsWith("x-run402-")) headers[name.toLowerCase()] = value;
  });
  headers[DATA_PLANE_ACTOR_TOKEN_HEADER] = session.access_token;
  headers["x-run402-request-id"] = requestId;
  const authTime = Math.floor(Date.parse(session.session.auth_time) / 1000);
  return {
    requestId,
    projectId: session.project_id,
    releaseId: "dev",
    locale: null,
    defaultLocale: null,
    host: new URL(request.url).host,
    request: { method: request.method, url: request.url, headers },
    actor: {
      id: session.user.id,
      email: session.user.email,
      isTest: true,
      emailVerified: session.user.email_verified,
      authTime,
      amr: [...session.session.amr],
      amrTimes: Object.fromEntries(session.session.amr.map((m) => [m, authTime])),
      authzVersion: authzVersionOf(session.access_token),
      sessionId: session.session.session_id,
    },
    invocationKind: "routed_http",
  };
}

/**
 * The middleware body, with its collaborators passed in so it can be tested
 * against the real `runWithContext` without Astro. After expiry it serves
 * anonymously and logs once.
 */
export function createDevSessionHandler(opts: {
  session: DevTestSession;
  runWithContext: RunWithContext;
  now?: () => number;
  requestId?: () => string;
  warn?: (message: string) => void;
}): (request: Request, next: () => Promise<Response>) => Promise<Response> {
  const now = opts.now ?? Date.now;
  const requestId = opts.requestId ?? (() => `dev_${crypto.randomUUID()}`);
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  let warned = false;
  return async (request, next) => {
    const context = devRequestContext(opts.session, request, now(), requestId());
    if (!context) {
      if (!warned) {
        warned = true;
        warn(
          `run402 dev: the test session for ${opts.session.user.email} expired; serving anonymously. ` +
            `Restart \`run402 dev --as ${opts.session.user.label}\` to sign in again.`,
        );
      }
      return next();
    }
    return opts.runWithContext(context, () => next());
  };
}
