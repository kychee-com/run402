/**
 * `projects` namespace — project lifecycle, introspection, and admin.
 *
 * Covers:
 *   - remote: provision, delete, list, getUsage, getSchema, getQuote
 *   - local:  info, keys, use (require provider support for persistence methods)
 *
 * Operator-only project actions live on the {@link Admin} namespace:
 *   - `admin.archiveProject` / `admin.reactivateProject` — moderate-archive
 *   - `admin.setLeasePerpetual` — organization-level escape hatch (replaces the
 *     v1.56 `projects.pin` removed in v1.57)
 */

import type { Client } from "../kernel.js";
import type { ProjectKeys } from "../credentials.js";
import { LocalError } from "../errors.js";
import { deprecatePositional } from "../deprecate.js";
import { requireProjectCredentials } from "../project-credentials.js";
import type { ExposeManifest } from "./deploy.types.js";
import type {
  ExposeManifestValidationInput,
  ExposeManifestValidationIssue,
  ExposeManifestValidationResult,
  ListProjectsOptions,
  ListProjectsResult,
  ProjectDetail,
  ProjectInfo,
  ProjectSummary,
  ProjectRestOptions,
  ProjectRestResponse,
  ProvisionOptions,
  ProvisionResult,
  QuoteResult,
  RenameProjectResult,
  SchemaReport,
  UsageReport,
  ValidateExposeOptions,
} from "./projects.types.js";

type WireProjectSummary = Omit<ProjectSummary, "id"> & {
  project_id?: string;
  id?: string;
  [key: string]: unknown;
};

function normalizeListProjectsResult(result: ListProjectsResult | { projects?: WireProjectSummary[] }): ListProjectsResult {
  const rows = Array.isArray(result.projects) ? result.projects : [];
  return {
    ...(result as ListProjectsResult),
    projects: rows.map((row) => {
      const raw = row as WireProjectSummary;
      const { project_id: projectId, id, ...rest } = raw;
      return { id: id ?? projectId ?? "", ...rest } as ProjectSummary;
    }),
  };
}

function normalizeAdminSqlResponse(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const rowCount = (value as { row_count?: unknown }).row_count;
  if (rowCount === undefined) return value;
  const { row_count: _drop, ...rest } = value as Record<string, unknown>;
  return { ...rest, rowCount };
}

function normalizeExposeValidationResult(value: ExposeManifestValidationResult | { has_errors?: boolean; errors?: ExposeManifestValidationIssue[]; warnings?: ExposeManifestValidationIssue[] }): ExposeManifestValidationResult {
  if ("hasErrors" in value) return value as ExposeManifestValidationResult;
  return {
    hasErrors: value.has_errors === true,
    errors: Array.isArray(value.errors) ? value.errors : [],
    warnings: Array.isArray(value.warnings) ? value.warnings : [],
  };
}

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
      const keys = await requireProjectCredentials(this.client, id, context);
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
    if (opts.orgId !== undefined) body.org_id = opts.orgId;

    const result = await this.client.request<ProvisionResult>("/projects/v1", {
      method: "POST",
      body,
      // Retry-safety: a caller-supplied key collapses a re-run (the agent's
      // natural mode after a crash) onto the same project instead of duplicating.
      ...(opts.idempotencyKey ? { headers: { "Idempotency-Key": opts.idempotencyKey } } : {}),
      // Operator-approval scope: creating a project in an org is `org.project.create`
      // targeting that org. Only meaningful when provisioning into an existing org.
      ...(opts.orgId
        ? {
            authMeta: {
              method: "projects.provision",
              capability: "org.project.create" as const,
              target: { org_id: opts.orgId },
            },
          }
        : {}),
      context: "provisioning project",
    });

    // Persist the new project and set it active, if the provider supports it.
    const creds = this.client.credentials;
    if (creds.saveProject) {
      await creds.saveProject(result.project_id, {
        anon_key: result.anon_key,
        service_key: result.service_key,
        ...(result.endpoints?.static_base_url ? { site_url: result.endpoints.static_base_url } : {}),
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
   * @throws {ProjectCredentialNotFound} if local project credentials are absent.
   */
  async delete(id: string): Promise<void> {
    const keys = await requireProjectCredentials(this.client, id, "deleting project");

    await this.client.request<unknown>(`/projects/v1/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${keys.service_key}` },
      context: "deleting project",
    });

    const creds = this.client.credentials;
    if (creds.removeProject) await creds.removeProject(id);
  }

  /**
   * List projects in the named, domain-aware inventory (gateway
   * `project-findability`). Each row carries `name`, `site_url`,
   * `custom_domains`, `org_id` (the owning org), `status`, and
   * `created_at`.
   *
   * Membership-scoped by default (`GET /projects/v1`): returns every project
   * owned by an org the caller's principal is an active member of. This is the
   * cold-start lone-agent path — `list()` with no options, authenticated with
   * SIWX wallet auth from the credential provider.
   *
   * - `{ org }` narrows to one owning org (authorize-before-reveal: a non-member
   *   or guessed id is a 403, a non-UUID id a 400).
   * - `{ all: true }` reads the operator email-union inventory across every
   *   wallet controlling the operator's verified email
   *   (`GET /agent/v1/operator/projects`). Pass `{ all: true, token }` with an
   *   operator-session token for the cross-wallet union; without `token`, `all`
   *   uses SIWX wallet auth and returns only that wallet's slice. The response
   *   echoes the resolved `scope` (`"email"` or `"wallet"`) and is unpaged.
   * - `{ limit, cursor }` paginate the membership-scoped read (server default
   *   50, max 200).
   *
   * @throws {Run402Error} with `context: "listing projects"` on the usual
   *   auth/network failures (e.g. `Unauthorized` when no allowance is
   *   configured and the gateway rejects the missing SIWX header).
   */
  async list(opts: ListProjectsOptions = {}): Promise<ListProjectsResult> {
    if (opts.all && opts.org !== undefined) {
      throw new LocalError(
        "projects.list({ all, org }): `all` (operator email-union) and `org` (single-org filter) are mutually exclusive.",
        "listing projects",
      );
    }

    if (opts.all) {
      // Operator email-union inventory (`--all`). With an operator-session
      // token, the gateway returns the cross-wallet union; without one, it
      // falls back to the SIWX wallet's own slice (same row shape either way).
      const headers = opts.token ? { Authorization: `Bearer ${opts.token}` } : undefined;
      const result = await this.client.request<ListProjectsResult>("/agent/v1/operator/projects", {
        context: "listing projects",
        ...(headers ? { headers, withAuth: false } : {}),
      });
      return normalizeListProjectsResult(result);
    }

    // Membership-scoped named inventory (`GET /projects/v1`). SIWX wallet auth
    // is mandatory server-side; the credential provider supplies the header.
    const qs = new URLSearchParams();
    if (opts.org !== undefined) qs.set("org_id", opts.org);
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.cursor !== undefined) qs.set("after", opts.cursor);
    const query = qs.toString();
    const result = await this.client.request<ListProjectsResult>(`/projects/v1${query ? `?${query}` : ""}`, {
      context: "listing projects",
    });
    return normalizeListProjectsResult(result);
  }

  /**
   * Rename a project (gateway `project-findability`, `PATCH /projects/v1/:id`).
   * Surfaces the project's `name` so a human can fix an auto-generated label.
   *
   * Authorization is org-membership based (`admin`+ on the owning org, or a
   * `project:write` grant) and authorize-before-reveal — an unauthorized caller
   * (including a guessed id) gets the same `Unauthorized` as a real-but-
   * unauthorized project, never a not-found oracle. The server validates the
   * name (non-empty, ≤ 200 chars, no control characters).
   *
   * Uses the caller's SIWX wallet auth (or a control-plane session) from the
   * credential provider — not a project service key — so it works without the
   * project being in the local keystore.
   *
   * @throws {Unauthorized} when the caller is not authorized for the project.
   * @throws {ApiError} (HTTP 400) when the new name is invalid.
   */
  async rename(projectId: string, name: string): Promise<RenameProjectResult> {
    return this.client.request<RenameProjectResult>(`/projects/v1/${projectId}`, {
      method: "PATCH",
      body: { name },
      context: "renaming project",
    });
  }

  /**
   * Get usage metrics for a project — API calls, storage, tier limits,
   * lease expiry.
   */
  async getUsage(id: string): Promise<UsageReport> {
    const keys = await requireProjectCredentials(this.client, id, "fetching usage");

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
    const keys = await requireProjectCredentials(this.client, id, "fetching schema");

    return this.client.request<SchemaReport>(`/projects/v1/admin/${id}/schema`, {
      headers: { Authorization: `Bearer ${keys.service_key}` },
      context: "fetching schema",
    });
  }

  /** Run SQL against the project's database using the service key. */
  async sql(id: string, sql: string, params?: unknown[]): Promise<unknown> {
    const keys = await requireProjectCredentials(this.client, id, "running SQL");

    const useParams = Array.isArray(params) && params.length > 0;
    const result = await this.client.request<unknown>(`/projects/v1/admin/${id}/sql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keys.service_key}`,
        "Content-Type": useParams ? "application/json" : "text/plain",
      },
      body: useParams ? { sql, params } : undefined,
      rawBody: useParams ? undefined : sql,
      context: "running SQL",
    });
    return normalizeAdminSqlResponse(result);
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
    const keys = await requireProjectCredentials(this.client, id, "querying REST");

    let opts: ProjectRestOptions;
    if (typeof queryOrOptions === "string") {
      deprecatePositional("projects.rest", "use rest(table, { query })");
      opts = { query: queryOrOptions };
    } else {
      opts = queryOrOptions ?? {};
    }
    const method = opts.method ?? "GET";
    const useService = opts.keyType === "service";
    const key = useService ? keys.service_key : keys.anon_key;
    const query = formatRestQuery(opts.query);
    const headers: Record<string, string> = {
      apikey: key,
      Authorization: `Bearer ${key}`,
    };
    if (method !== "GET") headers.Prefer = "return=representation";

    // The gateway rejects the service_role on the public PostgREST path
    // (/rest/v1/*), so service-key REST is routed through the admin REST
    // route (/admin/v1/rest/*). Anon keys use the public path.
    const path = useService
      ? `/admin/v1/rest/${encodeURIComponent(table)}${query}`
      : `/rest/v1/${encodeURIComponent(table)}${query}`;

    return this.client.requestWithResponse<T>(path, {
      method,
      headers,
      body: opts.body,
      context: "querying REST",
      withAuth: false,
    });
  }

  /** Apply the project's declarative expose manifest. */
  async applyExpose(id: string, manifest: ExposeManifest): Promise<unknown> {
    const keys = await requireProjectCredentials(this.client, id, "applying expose manifest");
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
      const keys = await requireProjectCredentials(this.client, project, "validating expose manifest");
      const result = await this.client.request<ExposeManifestValidationResult | { has_errors?: boolean; errors?: ExposeManifestValidationIssue[]; warnings?: ExposeManifestValidationIssue[] }>(
        `/projects/v1/admin/${project}/expose/validate`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${keys.service_key}` },
          body,
          context: "validating expose manifest",
          withAuth: false,
        },
      );
      return normalizeExposeValidationResult(result);
    }

    const result = await this.client.request<ExposeManifestValidationResult | { has_errors?: boolean; errors?: ExposeManifestValidationIssue[]; warnings?: ExposeManifestValidationIssue[] }>("/projects/v1/expose/validate", {
      method: "POST",
      body,
      context: "validating expose manifest",
    });
    return normalizeExposeValidationResult(result);
  }

  /** Fetch the project's current expose manifest. */
  async getExpose(id: string): Promise<ExposeManifest> {
    const keys = await requireProjectCredentials(this.client, id, "getting expose manifest");
    return this.client.request<ExposeManifest>(`/projects/v1/admin/${id}/expose`, {
      headers: { Authorization: `Bearer ${keys.service_key}` },
      context: "getting expose manifest",
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
   * Authoritative single-project read — `GET /projects/v1/:id` (gateway
   * `project.read`). Returns the server-side {@link ProjectDetail} (identity,
   * owning org, tier, lifecycle, site_url + custom domains, active-release
   * pointer, mailbox addresses, usage vs. tier limits). Carries no secrets.
   *
   * Uses the default credential (wallet SIWX or control-plane session) and does
   * NOT require the project to be in the local keystore — read a project you own
   * via org membership without provisioning it locally. Authorize-before-reveal:
   * a forbidden or absent project both surface as `Unauthorized`, never a 404.
   * For the local anon/service keys use {@link Projects.keys} instead.
   */
  async get(id: string): Promise<ProjectDetail> {
    return this.client.request<ProjectDetail>(`/projects/v1/${id}`, {
      context: "getting project",
    });
  }

  /**
   * Inspect a project from local state. Combines the project id with the
   * stored keys. Does not make an API call.
   *
   * @throws {ProjectCredentialNotFound} if local project credentials are absent.
   */
  async info(id: string): Promise<ProjectInfo> {
    const keys = await requireProjectCredentials(this.client, id, "fetching project info");
    return { project_id: id, ...keys };
  }

  /**
   * Return the stored anon/service keys for a project from local state.
   * Does not make an API call.
   *
   * @throws {ProjectCredentialNotFound} if local project credentials are absent.
   */
  async keys(id: string): Promise<ProjectKeys> {
    return requireProjectCredentials(this.client, id, "fetching project keys");
  }

  /**
   * Set the active/default project in local state. Requires the credential
   * provider to support `setActiveProject`.
   *
   * Returns `void`. To both persist the active project AND get a project-scoped
   * client in one call, use {@link Run402.useProject} instead:
   *
   *   const p = await r.useProject("prj_xxx");
   *   await p.apply.apply({ site: { ... } });
   *
   * @throws {Run402Error} if the authoritative project read is not allowed.
   * @throws {LocalError} if the provider does not support active-project state.
   */
  async use(id: string): Promise<void> {
    await this.get(id);

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
