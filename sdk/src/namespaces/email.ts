/**
 * `email` namespace — project mailboxes (send / list / get / raw / delete)
 * and mailbox webhooks. Most operations auto-resolve the project's mailbox
 * via the provider cache, falling back to a discovery GET when absent.
 */

import type { Client } from "../kernel.js";
import { ApiError, ProjectNotFound } from "../errors.js";

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export interface CreateMailboxResult {
  mailbox_id: string;
  address: string;
  slug: string;
  status: string;
}

export interface MailboxInfo {
  mailbox_id: string;
  address: string;
  slug?: string;
}

export type MailboxListResponse =
  | { mailboxes?: MailboxInfo[] }
  | MailboxInfo[];

export type EmailTemplate = "project_invite" | "magic_link" | "notification";

export interface SendEmailOptions {
  to: string;
  template?: EmailTemplate;
  variables?: Record<string, string>;
  subject?: string;
  html?: string;
  text?: string;
  from_name?: string;
  in_reply_to?: string;
}

export interface SendEmailResult {
  id: string;
  status: string;
  to: string;
  template?: string;
  subject?: string;
}

export interface EmailSummary {
  id: string;
  template: string;
  to: string;
  status: string;
  created_at: string;
}

export interface EmailDetail {
  id: string;
  template: string;
  to: string;
  status: string;
  variables: Record<string, string>;
  created_at: string;
  replies?: Array<{
    id: string;
    from: string;
    body: string;
    received_at: string;
  }>;
}

export interface ListEmailsOptions {
  limit?: number;
  after?: string;
}

export interface RawEmailResult {
  content_type: string;
  bytes: Uint8Array;
}

export interface MailboxWebhookSummary {
  webhook_id: string;
  url: string;
  events: string[];
  created_at: string;
}

export interface MailboxWebhooksResult {
  webhooks: MailboxWebhookSummary[];
}

export interface RegisterWebhookOptions {
  url: string;
  events: string[];
}

export interface UpdateWebhookOptions {
  url?: string;
  events?: string[];
}

export class Webhooks {
  constructor(
    private readonly client: Client,
    private readonly resolveMailbox: (projectId: string) => Promise<{ id: string; serviceKey: string }>,
  ) {}

  async register(projectId: string, opts: RegisterWebhookOptions): Promise<MailboxWebhookSummary> {
    const { id, serviceKey } = await this.resolveMailbox(projectId);
    return this.client.request<MailboxWebhookSummary>(`/mailboxes/v1/${id}/webhooks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}` },
      body: { url: opts.url, events: opts.events },
      context: "registering webhook",
    });
  }

  async list(projectId: string): Promise<MailboxWebhooksResult> {
    const { id, serviceKey } = await this.resolveMailbox(projectId);
    return this.client.request<MailboxWebhooksResult>(`/mailboxes/v1/${id}/webhooks`, {
      headers: { Authorization: `Bearer ${serviceKey}` },
      context: "listing webhooks",
    });
  }

  async get(projectId: string, webhookId: string): Promise<MailboxWebhookSummary> {
    const { id, serviceKey } = await this.resolveMailbox(projectId);
    return this.client.request<MailboxWebhookSummary>(
      `/mailboxes/v1/${id}/webhooks/${webhookId}`,
      {
        headers: { Authorization: `Bearer ${serviceKey}` },
        context: "getting webhook",
      },
    );
  }

  async update(
    projectId: string,
    webhookId: string,
    opts: UpdateWebhookOptions,
  ): Promise<MailboxWebhookSummary> {
    if (!opts.url && !opts.events) {
      throw new Error("Provide at least `url` or `events` to update a webhook.");
    }
    const { id, serviceKey } = await this.resolveMailbox(projectId);
    const body: Record<string, unknown> = {};
    if (opts.url) body.url = opts.url;
    if (opts.events) body.events = opts.events;
    return this.client.request<MailboxWebhookSummary>(
      `/mailboxes/v1/${id}/webhooks/${webhookId}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${serviceKey}` },
        body,
        context: "updating webhook",
      },
    );
  }

  async delete(projectId: string, webhookId: string): Promise<void> {
    const { id, serviceKey } = await this.resolveMailbox(projectId);
    await this.client.request<unknown>(`/mailboxes/v1/${id}/webhooks/${webhookId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${serviceKey}` },
      context: "deleting webhook",
    });
  }
}

export class Email {
  readonly webhooks: Webhooks;

  constructor(private readonly client: Client) {
    this.webhooks = new Webhooks(client, (projectId) => this.resolveMailbox(projectId));
  }

  /**
   * Resolve the project's mailbox id + service key. Prefers the provider's
   * cached value; falls back to a discovery GET and persists the result
   * when the provider supports `updateProject`.
   */
  private async resolveMailbox(projectId: string): Promise<{ id: string; serviceKey: string }> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "resolving mailbox");

    if (project.mailbox_id) {
      return { id: project.mailbox_id, serviceKey: project.service_key };
    }

    const list = await this.listMailboxes(project.service_key);
    if (list.length === 0) {
      throw new ApiError(
        "No mailbox found for this project. Use `create_mailbox` to create one first.",
        404,
        null,
        "resolving mailbox",
      );
    }
    const first = list[0]!;
    const updater = this.client.credentials.updateProject;
    if (updater) {
      try {
        await updater.call(this.client.credentials, projectId, {
          mailbox_id: first.mailbox_id,
          mailbox_address: first.address,
        });
      } catch {
        // best-effort cache — ignore failures
      }
    }
    return { id: first.mailbox_id, serviceKey: project.service_key };
  }

  private async listMailboxes(serviceKey: string): Promise<MailboxInfo[]> {
    const raw = await this.client.request<MailboxListResponse>(`/mailboxes/v1`, {
      headers: { Authorization: `Bearer ${serviceKey}` },
      context: "listing mailboxes",
    });
    return Array.isArray(raw) ? raw : raw.mailboxes ?? [];
  }

  /** Create a mailbox for a project. Idempotent: returns the existing one on 409. */
  async createMailbox(projectId: string, slug: string): Promise<CreateMailboxResult | MailboxInfo> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "creating mailbox");

    if (slug.length < 3 || slug.length > 63) {
      throw new Error("Slug must be 3-63 characters.");
    }
    if (!SLUG_RE.test(slug)) {
      throw new Error("Slug must be lowercase alphanumeric + hyphens, start/end with alphanumeric.");
    }
    if (slug.includes("--")) {
      throw new Error("Slug must not contain consecutive hyphens.");
    }

    try {
      const result = await this.client.request<CreateMailboxResult>("/mailboxes/v1", {
        method: "POST",
        headers: { Authorization: `Bearer ${project.service_key}` },
        body: { slug, project_id: projectId },
        context: "creating mailbox",
      });

      const updater = this.client.credentials.updateProject;
      if (updater) {
        await updater.call(this.client.credentials, projectId, {
          mailbox_id: result.mailbox_id,
          mailbox_address: result.address,
        });
      }
      return result;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Existing mailbox — try to discover and cache it. If discovery
        // fails or returns empty, re-throw the original 409 so the caller
        // sees the server's "already has a mailbox" message.
        try {
          const list = await this.listMailboxes(project.service_key);
          if (list.length > 0) {
            const existing = list[0]!;
            const updater = this.client.credentials.updateProject;
            if (updater) {
              await updater.call(this.client.credentials, projectId, {
                mailbox_id: existing.mailbox_id,
                mailbox_address: existing.address,
              });
            }
            return existing;
          }
        } catch {
          // fall through to re-throw the original 409
        }
      }
      throw err;
    }
  }

  /** Send an email via template or raw (subject + html) mode. */
  async send(projectId: string, opts: SendEmailOptions): Promise<SendEmailResult> {
    const hasSubject = !!opts.subject;
    const hasHtml = !!opts.html;
    const isRaw = hasSubject || hasHtml;
    const isTemplate = !!opts.template;
    if (!isRaw && !isTemplate) {
      throw new Error("Provide either `template` + `variables` or both `subject` + `html`.");
    }
    if (isRaw && isTemplate) {
      throw new Error("Provide `template` OR raw mode (`subject` + `html`), not both.");
    }
    if (isRaw && !(hasSubject && hasHtml)) {
      const missing = hasSubject ? "html" : "subject";
      throw new Error(`Raw mode requires both \`subject\` and \`html\` (missing \`${missing}\`).`);
    }

    const { id, serviceKey } = await this.resolveMailbox(projectId);
    const body: Record<string, unknown> = { to: opts.to };
    if (isTemplate) {
      body.template = opts.template;
      body.variables = opts.variables;
    } else {
      body.subject = opts.subject;
      body.html = opts.html;
      if (opts.text) body.text = opts.text;
    }
    if (opts.from_name) body.from_name = opts.from_name;
    if (opts.in_reply_to) body.in_reply_to = opts.in_reply_to;

    return this.client.request<SendEmailResult>(`/mailboxes/v1/${id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}` },
      body,
      context: "sending email",
    });
  }

  /** List messages in the project's mailbox. */
  async list(projectId: string, opts: ListEmailsOptions = {}): Promise<EmailSummary[]> {
    const { id, serviceKey } = await this.resolveMailbox(projectId);
    const qs = new URLSearchParams();
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.after) qs.set("after", opts.after);
    const path = `/mailboxes/v1/${id}/messages${qs.toString() ? "?" + qs.toString() : ""}`;
    return this.client.request<EmailSummary[]>(path, {
      headers: { Authorization: `Bearer ${serviceKey}` },
      context: "listing emails",
    });
  }

  /** Get a single message by id, including any replies. */
  async get(projectId: string, messageId: string): Promise<EmailDetail> {
    const { id, serviceKey } = await this.resolveMailbox(projectId);
    return this.client.request<EmailDetail>(`/mailboxes/v1/${id}/messages/${messageId}`, {
      headers: { Authorization: `Bearer ${serviceKey}` },
      context: "getting email",
    });
  }

  /**
   * Fetch the raw RFC-822 bytes of an inbound message. Returns `Uint8Array`
   * so the consumer can decode / store / forward without re-encoding.
   */
  async getRaw(projectId: string, messageId: string): Promise<RawEmailResult> {
    const { id, serviceKey } = await this.resolveMailbox(projectId);
    const url = `${this.client.apiBase}/mailboxes/v1/${id}/messages/${messageId}/raw`;
    const res = await this.client.fetch(url, {
      headers: { Authorization: `Bearer ${serviceKey}` },
    });
    if (!res.ok) {
      let body: unknown;
      try { body = await res.json(); } catch { body = await res.text().catch(() => ""); }
      throw new ApiError(
        `Fetching raw MIME failed (HTTP ${res.status})`,
        res.status,
        body,
        "fetching raw MIME",
      );
    }
    const buf = await res.arrayBuffer();
    return {
      content_type: res.headers.get("content-type") ?? "message/rfc822",
      bytes: new Uint8Array(buf),
    };
  }

  /** Get the project's mailbox info. Uses the cached mailbox_id when available. */
  async getMailbox(projectId: string): Promise<MailboxInfo> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "getting mailbox");
    const list = await this.listMailboxes(project.service_key);
    if (list.length === 0) {
      throw new ApiError(
        "No mailbox found for this project. Use `create_mailbox` to create one first.",
        404,
        null,
        "getting mailbox",
      );
    }
    const mb = list[0]!;
    const updater = this.client.credentials.updateProject;
    if (updater) {
      try {
        await updater.call(this.client.credentials, projectId, {
          mailbox_id: mb.mailbox_id,
          mailbox_address: mb.address,
        });
      } catch {
        // best-effort
      }
    }
    return mb;
  }

  /**
   * Delete the project's mailbox. Destructive — drops all messages and
   * webhook subscriptions. Pass `mailboxId` explicitly to delete a specific
   * mailbox; otherwise the project's current mailbox is resolved.
   */
  async deleteMailbox(projectId: string, mailboxId?: string): Promise<void> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "deleting mailbox");

    let id = mailboxId;
    if (!id) {
      if (project.mailbox_id) {
        id = project.mailbox_id;
      } else {
        const list = await this.listMailboxes(project.service_key);
        if (list.length === 0) {
          throw new ApiError(
            "No mailbox found for this project — nothing to delete.",
            404,
            null,
            "deleting mailbox",
          );
        }
        id = list[0]!.mailbox_id;
      }
    }

    await this.client.request<unknown>(`/mailboxes/v1/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${project.service_key}` },
      context: "deleting mailbox",
    });

    // Clear the cached mailbox_id so future calls re-discover.
    const updater = this.client.credentials.updateProject;
    if (updater) {
      try {
        await updater.call(this.client.credentials, projectId, {
          mailbox_id: undefined,
          mailbox_address: undefined,
        });
      } catch {
        // best-effort
      }
    }
  }
}
