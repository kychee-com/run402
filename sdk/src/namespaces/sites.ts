/**
 * `sites` namespace — static site deployments.
 *
 * As of v1.32 the inline-bytes deploy path (`POST /deployments/v1` with
 * base64 file blobs) is REMOVED at the gateway (returns 410 Gone). Callers
 * migrate to `NodeSites.deployDir` from `@run402/sdk/node`, which uses the
 * plan/commit transport over `/deploy/v1/plan` + `/deploy/v1/commit`.
 *
 * The isomorphic surface keeps only the public read-only `getDeployment`
 * call. `SiteFile` is preserved for `apps.bundleDeploy` (separate `/deploy/v1`
 * endpoint, unaffected by the v1.32 cutover).
 */

import type { Client } from "../kernel.js";

export interface SiteFile {
  /** File path relative to the site root (e.g. `"index.html"`, `"assets/logo.png"`). */
  file: string;
  /** File contents, either UTF-8 text or base64-encoded bytes. */
  data: string;
  encoding?: "utf-8" | "base64";
}

export interface SiteDeployResult {
  deployment_id: string;
  url: string;
  /** Total bytes across the manifest (present when reported by the gateway). */
  bytes_total?: number;
  /** Bytes uploaded in this deploy (0 on a no-op redeploy). */
  bytes_uploaded?: number;
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

  /** Get deployment metadata by id. Public — no project auth. */
  async getDeployment(deploymentId: string): Promise<DeploymentInfo> {
    return this.client.request<DeploymentInfo>(`/deployments/v1/${deploymentId}`, {
      context: "fetching deployment",
      withAuth: false,
    });
  }
}
