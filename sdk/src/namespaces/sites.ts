/**
 * `sites` namespace — static site deployments.
 *
 * As of v1.34 every static-site deploy flows through the unified
 * {@link Deploy.apply} primitive. The legacy isomorphic surface is empty
 * here; the Node-only `deployDir` convenience lives in
 * {@link "../node/sites-node".NodeSites}.
 *
 * `SiteFile` is preserved for `apps.bundleDeploy` callers that still pass
 * inline file bytes; the bundle shim translates these into a v2
 * {@link ReleaseSpec} before dispatching.
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

export class Sites {
  constructor(private readonly client: Client) {}
}
