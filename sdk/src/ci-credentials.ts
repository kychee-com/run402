/** CI-session credential helpers for OIDC-backed deploy flows. */

import type { CredentialsProvider, ProjectKeys } from "./credentials.js";
import { LocalError } from "./errors.js";
import { buildClient } from "./kernel.js";
import { Ci } from "./namespaces/ci.js";
import {
  CI_AUDIENCE,
  type CiTokenExchangeResponse,
} from "./namespaces/ci.types.js";

export const CI_SESSION_CREDENTIALS = Symbol.for("@run402/sdk/ci-session-credentials");

export interface CiMarkedCredentialsProvider extends CredentialsProvider {
  readonly [CI_SESSION_CREDENTIALS]: true;
}

export interface CreateCiSessionCredentialsOptions {
  projectId: string;
  accessToken?: string;
  getAccessToken?: () => Promise<string>;
}

export interface GithubActionsCredentialsOptions {
  projectId: string;
  apiBase?: string;
  audience?: string;
  refreshBeforeSeconds?: number;
  fetch?: typeof globalThis.fetch;
}

export function isCiSessionCredentials(
  credentials: CredentialsProvider,
): credentials is CiMarkedCredentialsProvider {
  return Boolean((credentials as Partial<CiMarkedCredentialsProvider>)[CI_SESSION_CREDENTIALS]);
}

export function createCiSessionCredentials(
  opts: CreateCiSessionCredentialsOptions,
): CiMarkedCredentialsProvider {
  if (!opts?.projectId) {
    throw new LocalError(
      "createCiSessionCredentials requires projectId",
      "creating CI session credentials",
    );
  }
  if (!opts.accessToken && !opts.getAccessToken) {
    throw new LocalError(
      "createCiSessionCredentials requires accessToken or getAccessToken",
      "creating CI session credentials",
    );
  }

  const provider: CredentialsProvider = {
    async getAuth() {
      const token = opts.getAccessToken ? await opts.getAccessToken() : opts.accessToken;
      if (!token) {
        throw new LocalError(
          "CI session credentials did not return an access token",
          "authenticating with CI session",
        );
      }
      return { Authorization: `Bearer ${token}` };
    },
    async getProject(id: string): Promise<ProjectKeys | null> {
      if (id !== opts.projectId) return null;
      return { anon_key: "", service_key: "" };
    },
    async getActiveProject(): Promise<string> {
      return opts.projectId;
    },
  };

  Object.defineProperty(provider, CI_SESSION_CREDENTIALS, {
    value: true,
    enumerable: false,
  });
  return provider as CiMarkedCredentialsProvider;
}

export function githubActionsCredentials(
  opts: GithubActionsCredentialsOptions,
): CiMarkedCredentialsProvider {
  if (!opts?.projectId) {
    throw new LocalError(
      "githubActionsCredentials requires projectId",
      "creating GitHub Actions CI credentials",
    );
  }
  const apiBase = opts.apiBase ?? CI_AUDIENCE;
  const audience = opts.audience ?? CI_AUDIENCE;
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const refreshBeforeMs = Math.max(0, opts.refreshBeforeSeconds ?? 60) * 1000;
  let cached: { token: string; refreshAtMs: number } | null = null;

  return createCiSessionCredentials({
    projectId: opts.projectId,
    getAccessToken: async () => {
      const now = Date.now();
      if (cached && now < cached.refreshAtMs) return cached.token;

      const subjectToken = await requestGithubOidcToken(fetchImpl, audience);
      const exchanged = await exchangeWithRun402Ci(fetchImpl, apiBase, opts.projectId, subjectToken);
      cached = {
        token: exchanged.access_token,
        refreshAtMs: now + Math.max(0, exchanged.expires_in * 1000 - refreshBeforeMs),
      };
      return cached.token;
    },
  });
}

async function requestGithubOidcToken(
  fetchImpl: typeof globalThis.fetch,
  audience: string,
): Promise<string> {
  const env = getProcessEnv();
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new LocalError(
      "GitHub Actions OIDC environment is missing ACTIONS_ID_TOKEN_REQUEST_URL or ACTIONS_ID_TOKEN_REQUEST_TOKEN. Ensure the workflow has permissions: id-token: write.",
      "requesting GitHub Actions OIDC token",
    );
  }

  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);
  const res = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${requestToken}` },
  });
  const body = await res.json().catch(() => null) as { value?: unknown } | null;
  if (!res.ok || typeof body?.value !== "string" || body.value.length === 0) {
    throw new LocalError(
      `GitHub Actions OIDC token request failed (HTTP ${res.status})`,
      "requesting GitHub Actions OIDC token",
    );
  }
  return body.value;
}

async function exchangeWithRun402Ci(
  fetchImpl: typeof globalThis.fetch,
  apiBase: string,
  projectId: string,
  subjectToken: string,
): Promise<CiTokenExchangeResponse> {
  const noAuth: CredentialsProvider = {
    async getAuth() {
      return null;
    },
    async getProject() {
      return null;
    },
  };
  const ci = new Ci(buildClient({
    apiBase,
    fetch: fetchImpl,
    credentials: noAuth,
  }));
  return ci.exchangeToken({ project_id: projectId, subject_token: subjectToken });
}

function getProcessEnv(): Record<string, string | undefined> {
  const proc = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return proc.process?.env ?? {};
}
