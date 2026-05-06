/**
 * @run402/sdk — typed TypeScript client for the Run402 API.
 *
 * This is the isomorphic entry point. Works in Node 22, Deno, Bun, and V8
 * isolates with no filesystem. For Node consumers that want zero-config
 * defaults (keystore + allowance + x402), use `@run402/sdk/node` instead.
 */

import { buildClient, type Client, type KernelConfig } from "./kernel.js";
import type { CredentialsProvider } from "./credentials.js";
import { Projects } from "./namespaces/projects.js";
import { Blobs } from "./namespaces/blobs.js";
import { Functions } from "./namespaces/functions.js";
import { Secrets } from "./namespaces/secrets.js";
import { Subdomains } from "./namespaces/subdomains.js";
import { Domains } from "./namespaces/domains.js";
import { Sites } from "./namespaces/sites.js";
import { Service } from "./namespaces/service.js";
import { Tier } from "./namespaces/tier.js";
import { Allowance } from "./namespaces/allowance.js";
import { Ai } from "./namespaces/ai.js";
import { Auth } from "./namespaces/auth.js";
import { SenderDomain } from "./namespaces/sender-domain.js";
import { Billing } from "./namespaces/billing.js";
import { Apps } from "./namespaces/apps.js";
import { Email } from "./namespaces/email.js";
import { Contracts } from "./namespaces/contracts.js";
import { Admin } from "./namespaces/admin.js";
import { Deploy } from "./namespaces/deploy.js";
import { Ci } from "./namespaces/ci.js";
import type { ContentSource, FileSet } from "./namespaces/deploy.types.js";
import { ScopedRun402 } from "./scoped.js";
import { LocalError } from "./errors.js";

export interface Run402Options {
  /** API base URL, e.g. `https://api.run402.com`. */
  apiBase: string;
  /** Credential provider. Required — there is no default in the isomorphic entry. */
  credentials: CredentialsProvider;
  /**
   * Custom fetch implementation. Defaults to `globalThis.fetch`. Node consumers
   * typically pass an x402-wrapped fetch; sandbox consumers may pass a
   * session-bound fetch provided by their supervisor.
   */
  fetch?: typeof globalThis.fetch;
}

export class Run402 {
  readonly projects: Projects;
  readonly blobs: Blobs;
  readonly functions: Functions;
  readonly secrets: Secrets;
  readonly subdomains: Subdomains;
  readonly domains: Domains;
  readonly sites: Sites;
  readonly service: Service;
  readonly tier: Tier;
  readonly allowance: Allowance;
  readonly ai: Ai;
  readonly image!: Ai;
  readonly auth: Auth;
  readonly senderDomain: SenderDomain;
  readonly billing: Billing;
  readonly apps: Apps;
  readonly email: Email;
  readonly contracts: Contracts;
  readonly admin: Admin;
  readonly deploy: Deploy;
  readonly ci: Ci;

  readonly #client: Client;

  constructor(opts: Run402Options) {
    if (!opts || typeof opts !== "object") {
      throw new LocalError(
        "Run402 requires an options object",
        "constructing client",
      );
    }
    if (!opts.apiBase || typeof opts.apiBase !== "string") {
      throw new LocalError(
        "Run402 requires opts.apiBase (a non-empty string)",
        "constructing client",
      );
    }
    if (!opts.credentials) {
      throw new LocalError(
        "Run402 requires opts.credentials. For Node defaults use `import { run402 } from '@run402/sdk/node'`. For sandbox/Deno/V8, pass a CredentialsProvider directly.",
        "constructing client",
      );
    }
    if (
      typeof opts.credentials.getAuth !== "function" ||
      typeof opts.credentials.getProject !== "function"
    ) {
      throw new LocalError(
        "Run402 credentials provider is missing required methods (getAuth, getProject)",
        "constructing client",
      );
    }
    const kernel: KernelConfig = {
      apiBase: opts.apiBase,
      fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
      credentials: opts.credentials,
    };
    const client: Client = buildClient(kernel);
    this.#client = client;
    this.projects = new Projects(client);
    this.blobs = new Blobs(client);
    this.functions = new Functions(client);
    this.secrets = new Secrets(client);
    this.subdomains = new Subdomains(client);
    this.domains = new Domains(client);
    this.sites = new Sites(client);
    this.service = new Service(client);
    this.tier = new Tier(client);
    this.allowance = new Allowance(client);
    this.ai = new Ai(client);
    Object.defineProperty(this, "image", {
      value: this.ai,
      enumerable: false,
    });
    this.auth = new Auth(client);
    this.senderDomain = new SenderDomain(client);
    this.billing = new Billing(client);
    this.apps = new Apps(client);
    this.email = new Email(client);
    this.contracts = new Contracts(client);
    this.admin = new Admin(client);
    this.deploy = new Deploy(client);
    this.ci = new Ci(client);
  }

  /**
   * Return a project-scoped sub-client where every project-id-bearing namespace
   * method has the id pre-bound. Methods on the scoped client drop their
   * `id`/`project_id`/`project` argument; caller-supplied values still win
   * (so you can address a different project ad-hoc through a scoped handle).
   *
   * Resolution rules:
   * - Explicit `id`: scope is bound to that id immediately. The keystore is
   *   NOT consulted at construction; the first method call that needs keys
   *   will throw `ProjectNotFound` if the id is unknown.
   * - No argument: the SDK calls `credentials.getActiveProject()`. Throws
   *   `LocalError` (context: "scoping client to project") when the provider
   *   does not implement `getActiveProject` or returns `null`.
   *
   * `project()` does NOT mutate keystore state — use {@link useProject} for
   * the persist-then-scope shorthand.
   */
  async project(id?: string): Promise<ScopedRun402> {
    let resolvedId = id;
    if (resolvedId === undefined) {
      const getter = this.#client.credentials.getActiveProject;
      if (!getter) {
        throw new LocalError(
          "r.project() with no id requires a credential provider that implements getActiveProject(). Pass an explicit id, or use @run402/sdk/node.",
          "scoping client to project",
        );
      }
      const active = await getter.call(this.#client.credentials);
      if (!active) {
        throw new LocalError(
          "No active project set. Call `r.projects.use(id)` (or `run402 projects use <id>`) to set one, or pass an explicit id to `r.project(id)`.",
          "scoping client to project",
        );
      }
      resolvedId = active;
    }
    return new ScopedRun402(this, this.#client, resolvedId);
  }

  /**
   * Persist `id` as the active project (via `r.projects.use(id)`) AND return a
   * project-scoped sub-client in one call. Equivalent to:
   *
   *   await r.projects.use(id);
   *   return r.project(id);
   *
   * Note: this mutates the credential provider's persistent active-project
   * state (the keystore on Node). Concurrent CLI runs share that state. For
   * transient in-script scoping that does not change the user's CLI default,
   * use {@link project} instead.
   */
  async useProject(id: string): Promise<ScopedRun402> {
    await this.projects.use(id);
    return this.project(id);
  }
}

/**
 * Build a `FileSet` from a path-keyed record of byte sources. A passthrough
 * convenience: the SDK can consume the same shape whether you call this or
 * pass the literal directly. Useful for IDE autocomplete on the
 * `ContentSource` union and for keeping deploy specs declarative.
 *
 * @example
 *   await r.deploy.apply({
 *     project,
 *     site: { replace: files({
 *       "index.html": "<h1>hi</h1>",
 *       "logo.png": logoBytes,
 *       "data.json": new Blob([JSON.stringify(d)], { type: "application/json" }),
 *     })},
 *   });
 */
export function files(record: Record<string, ContentSource>): FileSet {
  return record;
}

/**
 * Factory wrapper equivalent to `new Run402(opts)`. Reads better in code-mode
 * sandbox examples: `const r = run402({ ... })`.
 */
export function run402(opts: Run402Options): Run402 {
  return new Run402(opts);
}

export {
  Run402Error,
  PaymentRequired,
  ProjectNotFound,
  Unauthorized,
  ApiError,
  NetworkError,
  LocalError,
  Run402DeployError,
  isRun402Error,
  isPaymentRequired,
  isProjectNotFound,
  isUnauthorized,
  isApiError,
  isNetworkError,
  isLocalError,
  isDeployError,
  isRetryableRun402Error,
} from "./errors.js";
export type {
  Run402DeployErrorCode,
  Run402DeployErrorFix,
  Run402ErrorKind,
} from "./errors.js";
export { withRetry } from "./retry.js";
export type * from "./retry.js";
export type * from "./credentials.js";
export type * from "./kernel.js";
export {
  CI_SESSION_CREDENTIALS,
  createCiSessionCredentials,
  githubActionsCredentials,
  isCiSessionCredentials,
} from "./ci-credentials.js";
export type * from "./ci-credentials.js";
export { Deploy } from "./namespaces/deploy.js";
export {
  Ci,
  CI_AUDIENCE,
  CI_GITHUB_ACTIONS_ISSUER,
  CI_GITHUB_ACTIONS_PROVIDER,
  DEFAULT_CI_DELEGATION_CHAIN_ID,
  V1_CI_ALLOWED_ACTIONS,
  V1_CI_ALLOWED_EVENTS_DEFAULT,
  assertCiDeployableSpec,
  buildCiDelegationResourceUri,
  buildCiDelegationStatement,
  normalizeCiDelegationValues,
  validateCiNonce,
  validateCiSubjectMatch,
} from "./namespaces/ci.js";
export { ScopedRun402 } from "./scoped.js";
export type * from "./namespaces/admin.js";
export type * from "./namespaces/ai.js";
export type * from "./namespaces/allowance.js";
export type * from "./namespaces/apps.js";
export type * from "./namespaces/auth.js";
export type * from "./namespaces/billing.js";
export type * from "./namespaces/blobs.types.js";
export type * from "./namespaces/ci.types.js";
export type * from "./namespaces/contracts.js";
export type * from "./namespaces/deploy.types.js";
export type { ByteReader } from "./namespaces/deploy.js";
export type * from "./namespaces/domains.js";
export type * from "./namespaces/email.js";
export type * from "./namespaces/functions.types.js";
export type * from "./namespaces/projects.types.js";
export type * from "./namespaces/secrets.js";
export type * from "./namespaces/sender-domain.js";
export type * from "./namespaces/service.js";
export type * from "./namespaces/sites.js";
export type * from "./namespaces/subdomains.js";
export type * from "./namespaces/tier.js";
