/**
 * `sites` namespace — static site deployments via `/deployments/v1`.
 *
 * `deploy` uses allowance-based SIWX auth (no project service key — the
 * project is referenced in the request body). Callers persisting
 * `last_deployment_id` locally should do so after a successful response.
 */

import type { Client } from "../kernel.js";

export interface SiteFile {
  /** File path relative to the site root (e.g. `"index.html"`, `"assets/logo.png"`). */
  file: string;
  /** File contents, either UTF-8 text or base64-encoded bytes. */
  data: string;
  encoding?: "utf-8" | "base64";
}

export interface SiteDeployOptions {
  /** Files to deploy. Paths are relative to the site root. */
  files: SiteFile[];
  /** Deployment target label, e.g. `"production"`. */
  target?: string;
  /**
   * When true, unchanged files are copied from the previous deployment —
   * only changed/new files need to appear in `files`.
   */
  inherit?: boolean;
}

export interface SiteDeployResult {
  deployment_id: string;
  url: string;
}

export interface DeploymentInfo {
  id: string;
  name: string;
  url: string;
  project_id?: string;
  status: string;
  files_count: number;
  total_size: number;
}

export class Sites {
  constructor(private readonly client: Client) {}

  /**
   * Deploy a static site. Payment flows through the configured fetch wrapper
   * (x402 in Node when a tier purchase is required; typically free with an
   * active tier).
   */
  async deploy(projectId: string, opts: SiteDeployOptions): Promise<SiteDeployResult> {
    const body: Record<string, unknown> = { project: projectId, files: opts.files };
    if (opts.target !== undefined) body.target = opts.target;
    if (opts.inherit) body.inherit = true;

    return this.client.request<SiteDeployResult>("/deployments/v1", {
      method: "POST",
      body,
      context: "deploying site",
    });
  }

  /** Get deployment metadata by id. Public — no project auth. */
  async getDeployment(deploymentId: string): Promise<DeploymentInfo> {
    return this.client.request<DeploymentInfo>(`/deployments/v1/${deploymentId}`, {
      context: "fetching deployment",
      withAuth: false,
    });
  }
}
