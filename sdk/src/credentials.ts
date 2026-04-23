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

export interface CredentialsProvider {
  /**
   * Return per-request auth headers for the given API path, or null if none
   * are available. Typical headers: `SIGN-IN-WITH-X` (SIWE), `Authorization:
   * Bearer ...`. The kernel merges these into the request headers without
   * overwriting headers explicitly set on the request.
   */
  getAuth(path: string): Promise<Record<string, string> | null>;

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
}
