/**
 * Credential provider interface for the Run402 SDK.
 *
 * The SDK's request kernel calls `getAuth` before each request to obtain
 * signed auth headers, and `getProject` to resolve per-project anon/service
 * keys. All filesystem, environment, and session-state access lives inside
 * provider implementations — never in the kernel.
 *
 * Node consumers use {@link NodeCredentialsProvider} from `@run402/sdk/node`
 * which wraps the local keystore + allowance. Sandbox consumers supply their
 * own implementation bound to a session token issued by the supervisor.
 *
 * The two required methods (`getAuth`, `getProject`) support every API call.
 * The optional methods let providers opt in to local persistence (keystore
 * writes, active-project tracking). Namespace methods that need a missing
 * optional method throw a descriptive error at runtime.
 */

export interface ProjectKeys {
  anon_key: string;
  service_key: string;
  site_url?: string;
  deployed_at?: string;
  last_deployment_id?: string;
  mailbox_id?: string;
  mailbox_address?: string;
}

export interface AllowanceData {
  address: string;
  privateKey: string;
  created?: string;
  funded?: boolean;
  lastFaucet?: string;
  rail?: "x402" | "mpp";
}

/**
 * The active wallet's display identity. `name` is the local profile/selector
 * name (e.g. "kychon", or "default" for the root wallet); `label` is the
 * server-side display name, cached locally and `null` when unknown or offline.
 */
export interface WalletIdentity {
  name: string;
  address: string | null;
  label: string | null;
}

/**
 * Gateway write-auth (operator-approval) capabilities. Each is scoped to a
 * target: `org.project.create` → an org, the others → a project.
 */
export type WriteAuthCapability =
  | "org.project.create"
  | "project.deploy"
  | "project.secret.write"
  | "project.archives.export";

/** A write-capability target: an org (for `org.project.create`) or a project. */
export interface WriteAuthTarget {
  org_id?: string;
  project_id?: string;
}

/**
 * Per-request metadata a typed SDK method may pass to {@link
 * CredentialsProvider.getAuth}. `capability` + `target` let a provider decide
 * whether (and which) operator-approval credential to attach for a gated write.
 */
export interface AuthRequestMeta {
  /** Diagnostic: the SDK method name (e.g. "projects.provision"). */
  method?: string;
  /** The gateway write capability this request exercises, if any. */
  capability?: WriteAuthCapability;
  /** The capability's target. */
  target?: WriteAuthTarget;
}

export interface CredentialsProvider {
  /**
   * Return per-request auth headers for the given API path, or null if none
   * are available. Typical headers: `SIGN-IN-WITH-X` (SIWE), `Authorization:
   * Bearer ...`. The kernel merges these into the request headers without
   * overwriting headers explicitly set on the request.
   *
   * `metadata` (optional) carries the request's write capability + target so a
   * provider can attach a matching operator-approval credential. Providers that
   * ignore it (wallet-only) simply omit the parameter.
   */
  getAuth(path: string, metadata?: AuthRequestMeta): Promise<Record<string, string> | null>;

  /**
   * Resolve the anon/service keys for a project. Returns null if the project
   * is not known to this provider — the kernel then throws ProjectNotFound.
   */
  getProject(id: string): Promise<ProjectKeys | null>;

  /**
   * Persist project keys after a successful provision or deploy. Optional:
   * providers without local storage (pure session providers) may omit this.
   */
  saveProject?(id: string, project: ProjectKeys): Promise<void>;

  /** Partially update a project's stored fields (e.g. mailbox_id, last_deployment_id). Optional. */
  updateProject?(id: string, patch: Partial<ProjectKeys>): Promise<void>;

  /** Remove a project from local storage after deletion. Optional. */
  removeProject?(id: string): Promise<void>;

  /** Set the active/default project id in local state. Optional. */
  setActiveProject?(id: string): Promise<void>;

  /** Get the active/default project id from local state. Optional. */
  getActiveProject?(): Promise<string | null>;

  /** Read the local allowance (wallet). Optional — sandbox providers may omit. */
  readAllowance?(): Promise<AllowanceData | null>;

  /** Persist the local allowance. Optional. */
  saveAllowance?(data: AllowanceData): Promise<void>;

  /** Generate a fresh allowance keypair. Optional — Node default uses secp256k1 + keccak for the Ethereum address. */
  createAllowance?(): Promise<AllowanceData>;

  /** Return the absolute path to the local allowance file, for diagnostic output. Optional. */
  getAllowancePath?(): string;

  /**
   * Return the active wallet's display identity (local name + address + cached
   * server label). The Node provider derives this from the active profile;
   * sandbox/session providers may omit it. Used by {@link Run402.whoami}.
   */
  getWalletIdentity?(): Promise<WalletIdentity | null>;
}
