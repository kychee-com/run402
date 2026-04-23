/**
 * `secrets` namespace — project-scoped environment variables for functions.
 * All methods require the project's service key.
 */

import type { Client } from "../kernel.js";
import { ProjectNotFound } from "../errors.js";

export interface SecretSummary {
  key: string;
  value_hash?: string;
}

export interface SecretListResult {
  secrets: SecretSummary[];
}

export class Secrets {
  constructor(private readonly client: Client) {}

  /** Set or overwrite a project secret. Injected as `process.env.KEY` in deployed functions. */
  async set(projectId: string, key: string, value: string): Promise<void> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "setting secret");

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

  /** List secret keys for a project. Values are not returned — only key names and short hashes. */
  async list(projectId: string): Promise<SecretListResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "listing secrets");

    return this.client.request<SecretListResult>(
      `/projects/v1/admin/${projectId}/secrets`,
      {
        headers: { Authorization: `Bearer ${project.service_key}` },
        context: "listing secrets",
      },
    );
  }

  /** Delete a secret. */
  async delete(projectId: string, key: string): Promise<void> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "deleting secret");

    await this.client.request<unknown>(
      `/projects/v1/admin/${projectId}/secrets/${encodeURIComponent(key)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${project.service_key}` },
        context: "deleting secret",
      },
    );
  }
}
