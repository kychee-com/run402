/**
 * `projects` namespace — project lifecycle, introspection, and admin.
 *
 * Covers:
 *   - remote: provision, delete, list, getUsage, getSchema, setupRls, pin, getQuote
 *   - local:  info, keys, use (require provider support for persistence methods)
 */

import type { Client } from "../kernel.js";
import type { ProjectKeys } from "../credentials.js";
import { ProjectNotFound, Run402Error } from "../errors.js";
import type {
  ListProjectsResult,
  PinResult,
  ProjectInfo,
  ProvisionOptions,
  ProvisionResult,
  QuoteResult,
  RlsSetupOptions,
  RlsSetupResult,
  SchemaReport,
  UsageReport,
} from "./projects.types.js";

export class Projects {
  constructor(private readonly client: Client) {}

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
   */
  async list(wallet: string): Promise<ListProjectsResult> {
    const w = wallet.toLowerCase();
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

  /**
   * Apply a row-level-security template to one or more tables.
   *
   * ⚠ The gateway endpoint is deprecated (sunset 2026-05-23). Prefer the
   *   manifest-based `apply_expose` flow for new code.
   *
   * @throws {Run402Error} with `context: "setting up RLS"` when
   *   `i_understand_this_is_unrestricted` is missing for the
   *   `public_read_write_UNRESTRICTED` template.
   */
  async setupRls(id: string, opts: RlsSetupOptions): Promise<RlsSetupResult> {
    if (
      opts.template === "public_read_write_UNRESTRICTED" &&
      opts.i_understand_this_is_unrestricted !== true
    ) {
      throw new (class extends Run402Error {})(
        "i_understand_this_is_unrestricted must be true when template is public_read_write_UNRESTRICTED",
        null,
        null,
        "setting up RLS",
      );
    }

    const keys = await this.client.getProject(id);
    if (!keys) throw new ProjectNotFound(id, "setting up RLS");

    const body: Record<string, unknown> = {
      template: opts.template,
      tables: opts.tables,
    };
    if (opts.i_understand_this_is_unrestricted !== undefined) {
      body.i_understand_this_is_unrestricted = opts.i_understand_this_is_unrestricted;
    }

    return this.client.request<RlsSetupResult>(`/projects/v1/admin/${id}/rls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${keys.service_key}` },
      body,
      context: "setting up RLS",
    });
  }

  /**
   * Pin a project so it is not garbage-collected or expired.
   *
   * Admin only — the server-side `POST /projects/v1/admin/:id/pin`
   * endpoint requires run402 platform admin auth. Project owners
   * calling this with their `service_key` or SIWX session will receive
   * `403 admin_required`; this is by design and not a bug in the SDK.
   * The method is retained so operator tooling can share the same SDK.
   */
  async pin(id: string): Promise<PinResult> {
    const keys = await this.client.getProject(id);
    if (!keys) throw new ProjectNotFound(id, "pinning project");

    return this.client.request<PinResult>(`/projects/v1/admin/${id}/pin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${keys.service_key}` },
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
   * @throws {ProjectNotFound} if the id is unknown to the provider.
   * @throws {Error} if the provider does not support active-project state.
   */
  async use(id: string): Promise<void> {
    const keys = await this.client.getProject(id);
    if (!keys) throw new ProjectNotFound(id, "setting active project");

    const setter = this.client.credentials.setActiveProject;
    if (!setter) {
      throw new Error(
        "This credential provider does not support setActiveProject — `use` is only available with providers that track local active-project state.",
      );
    }
    await setter.call(this.client.credentials, id);
  }

  /**
   * Return the active/default project id in local state, or null when none
   * is set or the provider does not track active-project state.
   */
  async active(): Promise<string | null> {
    const getter = this.client.credentials.getActiveProject;
    if (!getter) return null;
    return getter.call(this.client.credentials);
  }
}
