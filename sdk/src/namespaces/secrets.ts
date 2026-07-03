/**
 * `secrets` namespace — project-scoped environment variables for functions.
 * All methods require the project's service key.
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import { requireProjectCredentials } from "../project-credentials.js";
import { deprecatePositional } from "../deprecate.js";

const SECRET_KEY_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SECRET_VALUE_LIMIT_BYTES = 4 * 1024;

export interface SecretSetOptions {
  value: string;
}

export interface SecretSummary {
  key: string;
  created_at?: string;
  updated_at?: string;
}

export interface SecretListResult {
  secrets: SecretSummary[];
}

export interface DeleteSecretResult {
  status: string;
  key: string;
}

export class Secrets {
  constructor(private readonly client: Client) {}

  /** Set or overwrite a project secret. Injected as `process.env.KEY` in deployed functions. */
  async set(projectId: string, key: string, opts: SecretSetOptions): Promise<void>;
  /** @deprecated Bare string value is swap-prone next to `key`. Use `set(projectId, key, { value })`. */
  async set(projectId: string, key: string, value: string): Promise<void>;
  async set(projectId: string, key: string, valueOrOpts: string | SecretSetOptions): Promise<void> {
    let value: string;
    if (typeof valueOrOpts === "object" && valueOrOpts !== null) {
      value = valueOrOpts.value;
    } else {
      deprecatePositional("secrets.set", "use set(projectId, key, { value })");
      value = valueOrOpts;
    }
    validateSecretKey(key, "setting secret");
    validateSecretValue(value);
    const project = await requireProjectCredentials(this.client, projectId, "setting secret");

    await this.client.request<unknown>(
      `/projects/v1/admin/${projectId}/secrets`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${project.service_key}` },
        body: { key, value },
        context: "setting secret",
      },
    );
  }

  /** List secret keys for a project. Values and value-derived hashes are never returned. */
  async list(projectId: string): Promise<SecretListResult> {
    const project = await requireProjectCredentials(this.client, projectId, "listing secrets");

    const body = await this.client.request<SecretListResult | SecretSummary[]>(
      `/projects/v1/admin/${projectId}/secrets`,
      {
        headers: { Authorization: `Bearer ${project.service_key}` },
        context: "listing secrets",
      },
    );
    return normalizeSecretList(body);
  }

  /** Delete a secret. */
  async delete(projectId: string, key: string): Promise<DeleteSecretResult> {
    const project = await requireProjectCredentials(this.client, projectId, "deleting secret");

    return this.client.request<DeleteSecretResult>(
      `/projects/v1/admin/${projectId}/secrets/${encodeURIComponent(key)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${project.service_key}` },
        context: "deleting secret",
      },
    );
  }
}

function validateSecretKey(key: string, context: string): void {
  if (typeof key !== "string" || !SECRET_KEY_RE.test(key)) {
    throw new LocalError(
      `Secret key must match ${SECRET_KEY_RE.source}`,
      context,
    );
  }
}

function validateSecretValue(value: string): void {
  if (typeof value !== "string") {
    throw new LocalError("Secret value must be a string", "setting secret");
  }
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > SECRET_VALUE_LIMIT_BYTES) {
    throw new LocalError(
      `Secret value is ${bytes} bytes; maximum is ${SECRET_VALUE_LIMIT_BYTES} UTF-8 bytes`,
      "setting secret",
    );
  }
}

function normalizeSecretList(body: SecretListResult | SecretSummary[] | unknown): SecretListResult {
  const raw = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { secrets?: unknown }).secrets)
      ? (body as { secrets: unknown[] }).secrets
      : [];
  const secrets = raw.flatMap((item): SecretSummary[] => {
    if (!item || typeof item !== "object") return [];
    const obj = item as Record<string, unknown>;
    if (typeof obj.key !== "string") return [];
    const out: SecretSummary = { key: obj.key };
    if (typeof obj.created_at === "string") out.created_at = obj.created_at;
    if (typeof obj.updated_at === "string") out.updated_at = obj.updated_at;
    return [out];
  });
  return { secrets };
}
