/**
 * `projects` namespace — project lifecycle, introspection, and admin.
 *
 * Covers:
 *   - remote: provision, delete, list, getUsage, getSchema, pin, getQuote
 *   - local:  info, keys, use (require provider support for persistence methods)
 */

import type { Client } from "../kernel.js";
import type { ProjectKeys } from "../credentials.js";
import { LocalError, ProjectNotFound } from "../errors.js";
import { assertEvmAddress } from "../validation.js";
import type { ExposeManifest } from "./deploy.types.js";
import type {
  ExposeManifestValidationInput,
  ExposeManifestValidationResult,
  ListProjectsResult,
  PinResult,
  ProjectInfo,
  ProjectRestOptions,
  ProjectRestResponse,
  ProvisionOptions,
  ProvisionResult,
  QuoteResult,
  SchemaReport,
  UsageReport,
  ValidateExposeOptions,
} from "./projects.types.js";

export class Projects {
  readonly schema: (id: string) => Promise<SchemaReport>;
  readonly usage: (id: string) => Promise<UsageReport>;
  readonly quote: () => Promise<QuoteResult>;
  readonly promoteUser: (id: string, email: string) => Promise<void>;
  readonly demoteUser: (id: string, email: string) => Promise<void>;

  constructor(private readonly client: Client) {
    this.schema = this.getSchema.bind(this);
    this.usage = this.getUsage.bind(this);
    this.quote = this.getQuote.bind(this);
    const role = async (id: string, email: string, action: "promote-user" | "demote-user", context: string) => {
      const keys = await this.client.getProject(id);
      if (!keys) throw new ProjectNotFound(id, context);
      await this.client.request<unknown>(`/projects/v1/admin/${id}/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${keys.service_key}` },
        body: { email },
        context,
      });
    };
    this.promoteUser = (id, email) => role(id, email, "promote-user", "promoting user");
    this.demoteUser = (id, email) => role(id, email, "demote-user", "demoting user");
  }

  /**
   * Provision a new Postgres project. Requires allowance auth; payment
   * flows through the configured fetch wrapper (x402 in Node, session
   * budget in sandbox). Returned keys are persisted to the local store
   * when the credential provider supports it.
   *
   * @throws {PaymentRequired} when the wallet has insufficient balance and
   *   the fetch wrapper cannot sign the 402 retry.
   */
  async provision(opts: ProvisionOptions = {}): Promise<ProvisionResult> {
    const body: Record<string, unknown> = {};
    if (opts.tier !== undefined) body.tier = opts.tier;
    if (opts.name !== undefined) body.name = opts.name;

    const result = await this.client.request<ProvisionResult>("/projects/v1", {
      method: "POST",
      body,
      context: "provisioning project",
    });

    // Persist the new project and set it active, if the provider supports it.
    const creds = this.client.credentials;
    if (creds.saveProject) {
      await creds.saveProject(result.project_id, {
        anon_key: result.anon_key,
        service_key: result.service_key,
      });
    }
    if (creds.setActiveProject) {
      await creds.setActiveProject(result.project_id);
    }
    return result;
  }

  /**
   * Immediately and irreversibly delete a project. Triggers the full
   * destructive cascade (drop tenant schema, delete Lambda functions,
   * release subdomains, tombstone mailbox, wipe secrets). Local keystore
   * is cleaned via the credential provider when supported.
   *
   * @throws {ProjectNotFound} if the id is unknown to the provider.
   */
  async delete(id: string): Promise<void> {
    const keys = await this.client.getProject(id);
    if (!keys) throw new ProjectNotFound(id, "deleting project");

    await this.client.request<unknown>(`/projects/v1/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${keys.service_key}` },
      context: "deleting project",
    });

    const creds = this.client.credentials;
    if (creds.removeProject) await creds.removeProject(id);
  }

  /**
   * List active projects for a wallet address. Public endpoint — no auth
   * required, no payment.
   *
   * When `wallet` is omitted, the SDK resolves it from the credential
   * provider's local allowance via `credentials.readAllowance()`. This mirrors
   * the optional-argument shape of {@link Allowance.faucet}.
   *
   * @throws {Run402Error} with `context: "listing projects"` when the
   *   argument is omitted and the provider does not implement
   *   `readAllowance` (typical for sandbox providers), or when
   *   `readAllowance()` returns `null` (no local allowance configured).
   */
  async list(wallet?: string): Promise<ListProjectsResult> {
    let resolvedWallet = wallet;
    if (resolvedWallet === undefined) {
      const reader = this.client.credentials.readAllowance;
      if (!reader) {
        throw new LocalError(
          "projects.list() with no wallet requires a credential provider that implements readAllowance(). Pass an explicit wallet, or use @run402/sdk/node.",
          "listing projects",
        );
      }
      const data = await reader.call(this.client.credentials);
      if (!data) {
        throw new LocalError(
          "No local allowance configured. Run `run402 allowance create`, or pass an explicit wallet.",
          "listing projects",
        );
      }
      resolvedWallet = data.address;
    }
    assertEvmAddress(resolvedWallet, "wallet", "listing projects");
    const w = resolvedWallet.toLowerCase();
    return this.client.request<ListProjectsResult>(`/wallets/v1/${w}/projects`, {
      context: "listing projects",
      withAuth: false,
    });
  }

  /**
   * Get usage metrics for a project — API calls, storage, tier limits,
   * lease expiry.
   */
  async getUsage(id: string): Promise<UsageReport> {
    const keys = await this.client.getProject(id);
    if (!keys) throw new ProjectNotFound(id, "fetching usage");

    return this.client.request<UsageReport>(`/projects/v1/admin/${id}/usage`, {
      headers: { Authorization: `Bearer ${keys.service_key}` },
      context: "fetching usage",
    });
  }

  /**
   * Introspect the project's database schema — tables, columns, types,
   * constraints, and RLS policies.
   */
  async getSchema(id: string): Promise<SchemaReport> {
    const keys = await this.client.getProject(id);
    if (!keys) throw new ProjectNotFound(id, "fetching schema");

    return this.client.request<SchemaReport>(`/projects/v1/admin/${id}/schema`, {
      headers: { Authorization: `Bearer ${keys.service_key}` },
      context: "fetching schema",
    });
  }

  /** Run SQL against the project's database using the service key. */
  async sql(id: string, sql: string, params?: unknown[]): Promise<unknown> {
    const keys = await this.client.getProject(id);
    if (!keys) throw new ProjectNotFound(id, "running SQL");

    const useParams = Array.isArray(params) && params.length > 0;
    return this.client.request<unknown>(`/projects/v1/admin/${id}/sql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keys.service_key}`,
        "Content-Type": useParams ? "application/json" : "text/plain",
      },
      body: useParams ? { sql, params } : undefined,
      rawBody: useParams ? undefined : sql,
      context: "running SQL",
    });
  }

  /** Query or mutate a project table through PostgREST. */
  async rest<T = unknown>(
    id: string,
    table: string,
    queryOrOptions?: string | ProjectRestOptions,
  ): Promise<T> {
    return (await this.restResponse<T>(id, table, queryOrOptions)).body;
  }

  /** Query or mutate a project table through PostgREST and preserve HTTP status. */
  async restResponse<T = unknown>(
    id: string,
    table: string,
    queryOrOptions?: string | ProjectRestOptions,
  ): Promise<ProjectRestResponse<T>> {
    const keys = await this.client.getProject(id);
    if (!keys) throw new ProjectNotFound(id, "querying REST");

    const opts: ProjectRestOptions =
      typeof queryOrOptions === "string"
        ? { query: queryOrOptions }
        : queryOrOptions ?? {};
    const method = opts.method ?? "GET";
    const key = opts.keyType === "service" ? keys.service_key : keys.anon_key;
    const query = formatRestQuery(opts.query);
    const headers: Record<string, string> = {
      apikey: key,
      Authorization: `Bearer ${key}`,
    };
    if (method !== "GET") headers.Prefer = "return=representation";

    return this.client.requestWithResponse<T>(`/rest/v1/${encodeURIComponent(table)}${query}`, {
      method,
      headers,
      body: opts.body,
      context: "querying REST",
      withAuth: false,
    });
  }

  /** Apply the project's declarative expose manifest. */
  async applyExpose(id: string, manifest: ExposeManifest): Promise<unknown> {
    const keys = await this.client.getProject(id);
    if (!keys) throw new ProjectNotFound(id, "applying expose manifest");
    return this.client.request<unknown>(`/projects/v1/admin/${id}/expose`, {
      method: "POST",
      headers: { Authorization: `Bearer ${keys.service_key}` },
      body: manifest,
      context: "applying expose manifest",
    });
  }

  /**
   * Validate an authorization/expose manifest without applying it.
   *
   * When `opts.project` / `opts.project_id` is supplied, the gateway validates
   * against that project's live schema using its service key. Otherwise it
   * performs projectless wallet-auth validation. `migrationSql` is validation
   * context only and is never executed.
   */
  async validateExpose(
    manifest: ExposeManifestValidationInput,
    opts: ValidateExposeOptions = {},
  ): Promise<ExposeManifestValidationResult> {
    const project = normalizeValidationProject(opts);
    const parsed = parseExposeManifestValidationInput(manifest);
    if ("hasErrors" in parsed) return parsed;

    const body: Record<string, unknown> = { manifest: parsed.manifest };
    if (opts.migrationSql !== undefined) body.migration_sql = opts.migrationSql;

    if (project) {
      const keys = await this.client.getProject(project);
      if (!keys) throw new ProjectNotFound(project, "validating expose manifest");
      return this.client.request<ExposeManifestValidationResult>(
        `/projects/v1/admin/${project}/expose/validate`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${keys.service_key}` },
          body,
          context: "validating expose manifest",
          withAuth: false,
        },
      );
    }

    return this.client.request<ExposeManifestValidationResult>("/projects/v1/expose/validate", {
      method: "POST",
      body,
      context: "validating expose manifest",
    });
  }

  /** Fetch the project's current expose manifest. */
  async getExpose(id: string): Promise<ExposeManifest> {
    const keys = await this.client.getProject(id);
    if (!keys) throw new ProjectNotFound(id, "getting expose manifest");
    return this.client.request<ExposeManifest>(`/projects/v1/admin/${id}/expose`, {
      headers: { Authorization: `Bearer ${keys.service_key}` },
      context: "getting expose manifest",
    });
  }

  /**
   * Pin a project so it is not garbage-collected or expired.
   *
   * Admin only — the server-side `POST /projects/v1/admin/:id/pin`
   * endpoint requires run402 platform admin auth. The Node SDK uses the
   * configured allowance wallet's SIWX headers for this call; project
   * service keys are intentionally not sent. Project owners calling with
   * a non-admin wallet will receive `403 admin_required`; this is by
   * design and not a bug in the SDK. The method is retained so operator
   * tooling can share the same SDK.
   */
  async pin(id: string): Promise<PinResult> {
    return this.client.request<PinResult>(`/projects/v1/admin/${id}/pin`, {
      method: "POST",
      headers: { "X-Admin-Mode": "1" },
      context: "pinning project",
    });
  }

  /**
   * Get tier pricing — prices, lease durations, storage limits, API-call
   * limits. Public, no auth, no payment.
   */
  async getQuote(): Promise<QuoteResult> {
    return this.client.request<QuoteResult>("/tiers/v1", {
      context: "getting quote",
      withAuth: false,
    });
  }

  /**
   * Inspect a project from local state. Combines the project id with the
   * stored keys. Does not make an API call.
   *
   * @throws {ProjectNotFound} if the id is unknown to the provider.
   */
  async info(id: string): Promise<ProjectInfo> {
    const keys = await this.client.getProject(id);
    if (!keys) throw new ProjectNotFound(id, "fetching project info");
    return { project_id: id, ...keys };
  }

  /**
   * Return the stored anon/service keys for a project from local state.
   * Does not make an API call.
   *
   * @throws {ProjectNotFound} if the id is unknown to the provider.
   */
  async keys(id: string): Promise<ProjectKeys> {
    const keys = await this.client.getProject(id);
    if (!keys) throw new ProjectNotFound(id, "fetching project keys");
    return keys;
  }

  /**
   * Set the active/default project in local state. Requires the credential
   * provider to support `setActiveProject`.
   *
   * Returns `void`. To both persist the active project AND get a project-scoped
   * client in one call, use {@link Run402.useProject} instead:
   *
   *   const p = await r.useProject("prj_xxx");
   *   await p.deploy.apply({ site: { ... } });
   *
   * @throws {ProjectNotFound} if the id is unknown to the provider.
   * @throws {LocalError} if the provider does not support active-project state.
   */
  async use(id: string): Promise<void> {
    const keys = await this.client.getProject(id);
    if (!keys) throw new ProjectNotFound(id, "setting active project");

    const setter = this.client.credentials.setActiveProject;
    if (!setter) {
      throw new LocalError(
        "This credential provider does not support setActiveProject — `use` is only available with providers that track local active-project state.",
        "setting active project",
      );
    }
    await setter.call(this.client.credentials, id);
  }

  /**
   * Return the active/default project id in local state, or null when none
   * is set or the provider does not track active-project state.
   *
   * To resolve the active project AND build a scoped sub-client in one call,
   * use {@link Run402.project} (no arg):
   *
   *   const p = await r.project();   // throws if no active project is set
   *   await p.functions.list();
   */
  async active(): Promise<string | null> {
    const getter = this.client.credentials.getActiveProject;
    if (!getter) return null;
    return getter.call(this.client.credentials);
  }
}

function formatRestQuery(query: ProjectRestOptions["query"]): string {
  if (query === undefined) return "";
  if (typeof query === "string") {
    if (!query) return "";
    return query.startsWith("?") ? query : `?${query}`;
  }
  const sp = new URLSearchParams(query);
  const out = sp.toString();
  return out ? `?${out}` : "";
}

function normalizeValidationProject(opts: ValidateExposeOptions): string | undefined {
  if (
    opts.project !== undefined &&
    opts.project_id !== undefined &&
    opts.project !== opts.project_id
  ) {
    throw new LocalError(
      "Pass only one project context to projects.validateExpose(): `project` and `project_id` differ.",
      "validating expose manifest",
    );
  }
  return opts.project ?? opts.project_id;
}

function parseExposeManifestValidationInput(
  manifest: ExposeManifestValidationInput,
): { manifest: unknown } | ExposeManifestValidationResult {
  if (typeof manifest !== "string") return { manifest };
  try {
    return { manifest: JSON.parse(manifest) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      hasErrors: true,
      errors: [
        {
          type: "schema-shape",
          severity: "error",
          detail: `Expose manifest JSON is invalid: ${message}`,
          fix: "Pass a JSON object matching the expose manifest v1 schema before running semantic validation.",
        },
      ],
      warnings: [],
    };
  }
}
