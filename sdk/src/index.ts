/**
 * @run402/sdk — typed TypeScript client for the Run402 API.
 *
 * This is the isomorphic entry point. Works in Node 22, Deno, Bun, and V8
 * isolates with no filesystem. For Node consumers that want zero-config
 * defaults (keystore + allowance + x402), use `@run402/sdk/node` instead.
 */

import { buildClient, type Client, type KernelConfig, type Run402ClientMetadata } from "./kernel.js";
import type { CredentialsProvider } from "./credentials.js";
import { Projects } from "./namespaces/projects.js";
import { Assets } from "./namespaces/assets.js";
import { Functions } from "./namespaces/functions.js";
import { Secrets } from "./namespaces/secrets.js";
import { Cache } from "./namespaces/cache.js";
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
import { Wallets, ScopedWallet } from "./namespaces/wallets.js";
import { Apps } from "./namespaces/apps.js";
import { Email } from "./namespaces/email.js";
import { Contracts } from "./namespaces/contracts.js";
import { Credentials } from "./namespaces/credentials.js";
import { Admin } from "./namespaces/admin.js";
import { Deploy } from "./namespaces/deploy.js";
import { Ci } from "./namespaces/ci.js";
import { Jobs } from "./namespaces/jobs.js";
import { Archives } from "./namespaces/archives.js";
import { Operator } from "./namespaces/operator.js";
import { Orgs, ScopedOrg } from "./namespaces/org.js";
import { Grants } from "./namespaces/grants.js";
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
  /**
   * Optional bounded client-version metadata for Node/supervised runtimes.
   * The SDK does not set this automatically in the isomorphic entry point, so
   * browser clients avoid surprise CORS preflights unless the caller explicitly
   * opts in.
   */
  clientMetadata?: Run402ClientMetadata | false;
}

export class Run402 {
  readonly apiBase: string;
  readonly projects: Projects;
  readonly assets: Assets;
  readonly functions: Functions;
  readonly secrets: Secrets;
  readonly cache: Cache;
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
  readonly wallets: Wallets;
  readonly apps: Apps;
  readonly email: Email;
  readonly contracts: Contracts;
  readonly credentials: Credentials;
  readonly admin: Admin;
  /**
   * Internal engine. Unified apply has no public `r.deploy` or `r.apply`
   * root surface — the sole hero is `r.project(id).apply`.
   * This property exists only so the scoped sub-client can delegate to the
   * engine implementation; do not call directly from user code.
   * @internal
   */
  readonly _applyEngine: Deploy;
  readonly ci: Ci;
  readonly jobs: Jobs;
  readonly archives: Archives;
  /**
   * The *human* (email) principal — browser-delegated operator session (RFC
   * 8628 device flow), distinct from the agent's per-wallet SIWX identity.
   */
  readonly operator: Operator;
  /**
   * Org collection + identity (gateway v1.77+, first-class in v1.82):
   * `r.orgs.create()` / `list()` / `whoami()`. For operations on a single org by
   * id use the scoped sub-client {@link Run402.org} (`r.org(id).get()` /
   * `rename()` / `members.*` / `invites.*` / `audit()`). Distinct from the local,
   * network-free {@link Run402.whoami}.
   */
  readonly orgs: Orgs;
  /**
   * Per-project capability grants for agent/CI principals. Also available
   * project-scoped as `r.project(id).grants`.
   */
  readonly grants: Grants;
  readonly idempotency = {
    fromParts,
  };

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
      (
        typeof opts.credentials.getProjectCredentials !== "function" &&
        typeof opts.credentials.getProject !== "function"
      )
    ) {
      throw new LocalError(
        "Run402 credentials provider is missing required methods (getAuth, getProjectCredentials)",
        "constructing client",
      );
    }
    const kernel: KernelConfig = {
      apiBase: opts.apiBase,
      fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
      credentials: opts.credentials,
      clientMetadata: opts.clientMetadata,
    };
    this.apiBase = opts.apiBase;
    const client: Client = buildClient(kernel);
    this.#client = client;
    this.projects = new Projects(client);
    this.assets = new Assets(client);
    this.functions = new Functions(client);
    this.secrets = new Secrets(client);
    this.cache = new Cache(client);
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
    this.wallets = new Wallets(client);
    this.apps = new Apps(client);
    this.email = new Email(client);
    this.contracts = new Contracts(client);
    this.credentials = new Credentials(client);
    this.admin = new Admin(client);
    this._applyEngine = new Deploy(client);
    this.ci = new Ci(client);
    this.jobs = new Jobs(client);
    this.archives = new Archives(client);
    this.operator = new Operator(client);
    this.orgs = new Orgs(client);
    this.grants = new Grants(client);
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

  /**
   * Return an org-scoped sub-client with `id` pre-bound — the org analog of
   * {@link Run402.project}. Instance operations (`get`, `rename`, `members.*`,
   * `invites.*`, `audit`) drop their org-id argument. Synchronous: an org id is
   * always explicit (there is no "active org" fallback). Collection/identity
   * operations (`create`, `list`, `whoami`) live on {@link Run402.orgs}.
   */
  org(id: string): ScopedOrg {
    return new ScopedOrg(this.#client, id);
  }

  /**
   * Return a wallet-scoped sub-client with `address` pre-bound — the wallet
   * analog of {@link Run402.project}. Exposes `getLabel()` / `setLabel(label)`
   * without the address as a swappable positional. Lazy and synchronous (no key
   * or network access at construction).
   */
  wallet(address: string): ScopedWallet {
    return new ScopedWallet(this.#client, address);
  }

  /**
   * Identify the active wallet and project: `{ local_label, server_label,
   * address, activeProject }`. `local_label` is the local wallet/profile
   * selector (e.g. "kychon", or "default"); `server_label` is the server-side
   * display name (null when unknown/offline); `address` is the wallet address;
   * `activeProject` is the currently-selected project id (null if none).
   *
   * Degrades gracefully: providers that don't implement `getWalletIdentity`
   * (sandbox/session) still get `address` from `readAllowance` when available.
   */
  async whoami(): Promise<WhoAmI> {
    const creds = this.#client.credentials;
    const identity = creds.getWalletIdentity ? await creds.getWalletIdentity.call(creds) : null;
    let address = identity?.address ?? null;
    if (address == null && creds.readAllowance) {
      address = (await creds.readAllowance.call(creds))?.address ?? null;
    }
    const activeProject = creds.getActiveProject
      ? await creds.getActiveProject.call(creds)
      : null;
    return {
      local_label: identity?.name ?? null,
      server_label: identity?.label ?? null,
      address,
      activeProject: activeProject ?? null,
    };
  }
}

/** Result of {@link Run402.whoami}. */
export interface WhoAmI {
  /** Local wallet/profile selector name (e.g. "kychon", "default"), or null. */
  local_label: string | null;
  /** Server-side display label, cached locally; null when unknown/offline. */
  server_label: string | null;
  /** Wallet address, or null when no allowance is configured. */
  address: string | null;
  /** Active project id, or null when none is selected. */
  activeProject: string | null;
}

/**
 * Build a `FileSet` from a path-keyed record of byte sources. A passthrough
 * convenience: the SDK can consume the same shape whether you call this or
 * pass the literal directly. Useful for IDE autocomplete on the
 * `ContentSource` union and for keeping deploy specs declarative.
 *
 * @example
 *   await (await r.project(project)).apply({
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

export function fromParts(...parts: Array<string | number | boolean | null | undefined>): string {
  const cleaned = parts
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .map((part) => encodeURIComponent(String(part)));
  if (cleaned.length === 0) {
    throw new LocalError(
      "idempotency.fromParts requires at least one non-empty part",
      "building idempotency key",
    );
  }
  return cleaned.join(":");
}

/**
 * Factory wrapper equivalent to `new Run402(opts)`. Reads better in code-mode
 * sandbox examples: `const r = run402({ ... })`.
 */
export function run402(opts: Run402Options): Run402 {
  return new Run402(opts);
}

export type { Run402ClientMetadata } from "./kernel.js";

export {
  Run402Error,
  PaymentRequired,
  ProjectCredentialNotFound,
  ProjectNotFound,
  Unauthorized,
  NotAuthorizedError,
  ApiError,
  NetworkError,
  LocalError,
  Run402DeployError,
  TransferFreezeError,
  StepUpRequiredError,
  OperatorApprovalRequiredError,
  PROJECT_CREDENTIAL_ERROR_CODES,
  isRun402Error,
  isPaymentRequired,
  isProjectCredentialError,
  isProjectCredentialExpired,
  isProjectCredentialInvalid,
  isProjectCredentialNotFound,
  isProjectCredentialProjectMismatch,
  isProjectNotFound,
  isUnauthorized,
  isNotAuthorized,
  isApiError,
  isNetworkError,
  isLocalError,
  isDeployError,
  isTransferFreezeError,
  isStepUpRequired,
  isOperatorApprovalRequired,
  isRetryableRun402Error,
  getQuotaScope,
} from "./errors.js";
export type {
  Run402DeployErrorCode,
  Run402DeployErrorFix,
  Run402ErrorKind,
  Run402QuotaScope,
  ProjectCredentialErrorCode,
  NextAction,
  NextActionType,
} from "./errors.js";
export { withRetry } from "./retry.js";
export type * from "./retry.js";
export { Run402Action } from "./actions.js";
export type * from "./actions.js";
export {
  defineConfig,
  dir,
  emailTrigger,
  file,
  nodeFunction,
  scheduleTrigger,
  sqlFile,
} from "./config.js";
export type * from "./config.js";
export type * from "./credentials.js";
export type * from "./kernel.js";
export {
  PROJECT_OPERATION_AUTH_CLASSIFICATIONS,
  projectOperationAuthClassification,
} from "./project-auth-classification.js";
export type * from "./project-auth-classification.js";
export {
  CI_SESSION_CREDENTIALS,
  createCiSessionCredentials,
  githubActionsCredentials,
  isCiSessionCredentials,
} from "./ci-credentials.js";
export type * from "./ci-credentials.js";
export * from "./app-up.js";
export {
  CONTROL_PLANE_SESSION_CREDENTIALS,
  controlPlaneSessionCredentials,
  isControlPlaneSessionCredentials,
} from "./control-plane-credentials.js";
export type * from "./control-plane-credentials.js";
export {
  EMPTY_STATIC_MANIFEST_METADATA,
  ROUTE_HTTP_METHODS,
  buildDeployResolveSummary,
  isDeployResolveRouteHit,
  isDeployResolveStaticHit,
  normalizeDeployResolveRequest,
  normalizeStaticManifestMetadata,
  summarizeDeployResult,
} from "./namespaces/deploy.types.js";
export {
  Ci,
  CI_AUDIENCE,
  CI_BINDING_REVOKED_ERROR,
  CI_GITHUB_ACTIONS_ISSUER,
  CI_GITHUB_ACTIONS_PROVIDER,
  DEFAULT_CI_DELEGATION_CHAIN_ID,
  V1_CI_ALLOWED_ACTIONS,
  V1_CI_ALLOWED_EVENTS_DEFAULT,
  assertCiDeployableSpec,
  buildCiDelegationResourceUri,
  buildCiDelegationStatement,
  isCiBindingRevoked,
  normalizeCiRouteScopes,
  normalizeCiDelegationValues,
  validateCiNonce,
  validateCiRouteScope,
  validateCiSubjectMatch,
} from "./namespaces/ci.js";
export { ScopedRun402 } from "./scoped.js";
export type * from "./namespaces/admin.js";
export type * from "./namespaces/transfers.js";
export { Transfers } from "./namespaces/transfers.js";
export type * from "./namespaces/ai.js";
export type * from "./namespaces/allowance.js";
export type * from "./namespaces/apps.js";
export type * from "./namespaces/auth.js";
export type * from "./namespaces/billing.js";
export type * from "./namespaces/cache.js";
export type * from "./namespaces/assets.types.js";
export type * from "./namespaces/ci.types.js";
export type * from "./namespaces/contracts.js";
export type * from "./namespaces/credentials.js";
export type * from "./namespaces/deploy.types.js";
export { Deploy } from "./namespaces/deploy.js";
export type { ByteReader } from "./namespaces/deploy.js";
export type * from "./namespaces/domains.js";
export type * from "./namespaces/email.js";
export { FunctionRunTerminalError, FunctionRuns } from "./namespaces/functions.js";
export type * from "./namespaces/functions.types.js";
export type * from "./namespaces/jobs.js";
export type * from "./namespaces/operator.js";
export { OperatorSession } from "./namespaces/operator-session.js";
export type * from "./namespaces/operator-session.js";
export { Orgs, ScopedOrg, OrgMembers, OrgInvites } from "./namespaces/org.js";
export type * from "./namespaces/org.types.js";
export { Grants } from "./namespaces/grants.js";
export type * from "./namespaces/grants.types.js";
export { Archives } from "./namespaces/archives.js";
export type * from "./namespaces/archives.types.js";
export type * from "./namespaces/projects.types.js";
export type * from "./namespaces/secrets.js";
export type * from "./namespaces/sender-domain.js";
export type * from "./namespaces/service.js";
export type * from "./namespaces/sites.js";
export type * from "./namespaces/subdomains.js";
export type * from "./namespaces/tier.js";
export { ScopedWallet } from "./namespaces/wallets.js";
export type * from "./namespaces/wallets.js";
