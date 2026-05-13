/**
 * `sites` namespace — static site deployments.
 *
 * As of v1.34 every static-site deploy flows through the unified
 * {@link Deploy.apply} primitive. The legacy isomorphic surface is empty
 * here; the Node-only `deployDir` convenience lives in
 * {@link "../node/sites-node".NodeSites}.
 */

import type { Client } from "../kernel.js";

export interface SiteDeployResult {
  deployment_id: string;
  url: string;
  /** Total bytes across the manifest (present when reported by the gateway). */
  bytes_total?: number;
  /** Bytes uploaded in this deploy (0 on a no-op redeploy). */
  bytes_uploaded?: number;
}

export class Sites {
  constructor(private readonly client: Client) {}
}
