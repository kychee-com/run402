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
import type { ContentSource, FileSet } from "./namespaces/deploy.types.js";

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
  readonly auth: Auth;
  readonly senderDomain: SenderDomain;
  readonly billing: Billing;
  readonly apps: Apps;
  readonly email: Email;
  readonly contracts: Contracts;
  readonly admin: Admin;
  readonly deploy: Deploy;

  constructor(opts: Run402Options) {
    const kernel: KernelConfig = {
      apiBase: opts.apiBase,
      fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
      credentials: opts.credentials,
    };
    const client: Client = buildClient(kernel);
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
    this.auth = new Auth(client);
    this.senderDomain = new SenderDomain(client);
    this.billing = new Billing(client);
    this.apps = new Apps(client);
    this.email = new Email(client);
    this.contracts = new Contracts(client);
    this.admin = new Admin(client);
    this.deploy = new Deploy(client);
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
} from "./errors.js";
export type {
  Run402DeployErrorCode,
  Run402DeployErrorFix,
} from "./errors.js";
export type { CredentialsProvider, ProjectKeys } from "./credentials.js";
export type { RequestOptions, Client } from "./kernel.js";
export { Deploy } from "./namespaces/deploy.js";
export type {
  ApplyOptions,
  CommitResponse,
  CommitStatus,
  ContentRef,
  ContentSource,
  DatabaseSpec,
  DeployDiff,
  DeployEvent,
  DeployOperation,
  DeployResult,
  ExposeManifest,
  FileSet,
  FsFileSource,
  FunctionSpec,
  FunctionsSpec,
  MigrationSpec,
  MissingContent,
  OperationSnapshot,
  OperationStatus,
  PaymentRequiredHint,
  PlanRequest,
  PlanResponse,
  ReleaseSpec,
  RouteSpec,
  SecretsSpec,
  SiteSpec,
  SmokeCheck,
  StartOptions,
  SubdomainsSpec,
} from "./namespaces/deploy.types.js";
